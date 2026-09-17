"""Injectable HTTP layer.

The pipeline only talks to the network through an object with a `get` method.
Production uses RequestsClient. Tests pass a fake that serves synthetic bodies,
and tests/conftest.py blocks real sockets so nothing can slip through.

RequestsClient also refuses any aaa.com host unless it was built with
allow_aaa=True, which update_data.py only does when AAA_ENABLED is "true".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Protocol
from urllib.parse import urlsplit

from requests.structures import CaseInsensitiveDict

USER_AGENT = "Mozilla/5.0 (compatible; DailyFuel/1.0; +https://github.com/lazizbekravshanov/DailyFuel)"

# The real workbook is about 740 KB and the other responses are far smaller.
# 16 MB is roughly 20x the biggest thing we ever expect, and it bounds what a
# hostile or broken upstream can make the runner hold in memory.
MAX_BODY = 16 * 1024 * 1024


class NetworkError(Exception):
    """Connection failed, timed out, or the response could not be read."""


class AaaDisabledError(RuntimeError):
    """Raised when something tries to reach aaa.com while AAA is switched off."""


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes
    url: str
    headers: CaseInsensitiveDict = field(default_factory=CaseInsensitiveDict)

    @classmethod
    def make(cls, status: int, body: bytes | str = b"", url: str = "", headers: Mapping[str, str] | None = None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        return cls(status=status, body=body, url=url, headers=CaseInsensitiveDict(headers or {}))


class HttpClient(Protocol):
    def get(self, url: str, headers: Mapping[str, str] | None = None, timeout: float = 30) -> Response: ...


def is_aaa_host(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    return host == "aaa.com" or host.endswith(".aaa.com")


class RequestsClient:
    """Real HTTP client backed by requests.Session."""

    def __init__(self, allow_aaa: bool = False, session=None):
        import requests

        self._requests = requests
        self.allow_aaa = allow_aaa
        self.session = session or requests.Session()

    def get(self, url: str, headers: Mapping[str, str] | None = None, timeout: float = 30) -> Response:
        if is_aaa_host(url) and not self.allow_aaa:
            raise AaaDisabledError(f"refusing to contact {url} because AAA is switched off")
        merged = {"User-Agent": USER_AGENT}
        merged.update(headers or {})
        try:
            r = self.session.get(
                url,
                headers=merged,
                timeout=timeout,
                allow_redirects=True,
                stream=True,
                hooks={"response": self._check_redirect},
            )
            try:
                # iter_content undoes Content-Encoding as it goes, so counting
                # these bytes caps the decompressed size, not just the wire size.
                chunks, total = [], 0
                for chunk in r.iter_content(65536):
                    total += len(chunk)
                    if total > MAX_BODY:
                        raise NetworkError(f"{url} returned more than {MAX_BODY} bytes")
                    chunks.append(chunk)
                body = b"".join(chunks)
            finally:
                r.close()
        except self._requests.RequestException as e:
            raise NetworkError(f"{type(e).__name__}: {e}") from e
        if is_aaa_host(r.url) and not self.allow_aaa:
            raise AaaDisabledError(f"redirected to {r.url} while AAA is switched off")
        return Response(status=r.status_code, body=body, url=r.url, headers=CaseInsensitiveDict(r.headers))

    def _check_redirect(self, r, *args, **kwargs):
        # Runs on every response before requests follows a redirect.
        if r.is_redirect and not self.allow_aaa:
            target = r.headers.get("Location", "")
            if target and is_aaa_host(target):
                raise AaaDisabledError(f"refusing redirect to {target} because AAA is switched off")
        return r
