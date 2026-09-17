"""The HTTP layer's response size cap.

Untrusted upstream bytes are the one place where a hostile or broken server
could make the runner hold an unbounded amount in memory.
"""

from __future__ import annotations

import gzip

import pytest

from dailyfuel import aaa
from dailyfuel.http import MAX_BODY, NetworkError, RequestsClient


class FakeResponse:
    status_code = 200
    headers: dict[str, str] = {}
    url = "https://example.invalid/big"
    is_redirect = False

    def __init__(self, total: int, chunk: int = 65536):
        self.total = total
        self.chunk = chunk
        self.closed = False

    def iter_content(self, size):
        sent = 0
        while sent < self.total:
            n = min(size, self.total - sent)
            sent += n
            yield b"\0" * n

    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self, response: FakeResponse):
        self.response = response

    def get(self, url, **kwargs):
        assert kwargs["stream"] is True, "the body must be streamed so it can be capped"
        return self.response


def test_body_past_the_cap_is_a_network_error():
    resp = FakeResponse(MAX_BODY + 65536)
    client = RequestsClient(session=FakeSession(resp))
    with pytest.raises(NetworkError, match="more than"):
        client.get(resp.url)
    assert resp.closed, "the connection must be closed on the way out"


def test_a_normal_sized_body_still_comes_back_whole():
    resp = FakeResponse(740_000)
    client = RequestsClient(session=FakeSession(resp))
    got = client.get(resp.url)
    assert len(got.body) == 740_000
    assert got.status == 200
    assert resp.closed


def test_gzip_bomb_is_rejected_instead_of_expanded():
    # 64 MiB of zeros compresses to about 64 KB. Left unbounded, a 60 MB body
    # would expand to tens of gigabytes.
    body = gzip.compress(b"\0" * (64 * 1024 * 1024))
    assert len(body) < 100_000
    with pytest.raises(aaa.Invalid, match="expands past"):
        aaa.decode_body(body)


def test_a_normal_gzip_body_still_decodes():
    assert aaa.decode_body(gzip.compress(b"<html>hello</html>")) == "<html>hello</html>"
