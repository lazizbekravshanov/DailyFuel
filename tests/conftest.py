"""Test setup: import path, a hard block on real sockets, and shared fixtures.

The socket block is installed when this file is imported, before any test
module loads. A test that accidentally reaches for the network fails loudly
instead of quietly falling back.
"""

from __future__ import annotations

import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))


class NetworkBlocked(RuntimeError):
    """Deliberately not an OSError, so HTTP libraries can't swallow it."""


def _blocked(*args, **kwargs):
    raise NetworkBlocked("real network access is blocked in tests")


socket.socket.connect = _blocked
socket.socket.connect_ex = _blocked
socket.socket.sendto = _blocked
socket.create_connection = _blocked
socket.getaddrinfo = _blocked
socket.gethostbyname = _blocked
socket.gethostbyname_ex = _blocked


from dailyfuel import store  # noqa: E402
from dailyfuel.states import load_states  # noqa: E402

import synth  # noqa: E402


@pytest.fixture(scope="session")
def states():
    return load_states()


@pytest.fixture(scope="session")
def validators():
    return store.validators()


@pytest.fixture
def now():
    # Thursday 2026-09-17, 12:17 UTC (08:17 in New York).
    return datetime(2026, 9, 17, 12, 17, 3, tzinfo=timezone.utc)


@pytest.fixture
def fake_http():
    return synth.FakeHttp()


@pytest.fixture
def sleeps():
    calls = []
    calls_append = calls.append

    def sleep(seconds):
        calls_append(seconds)

    sleep.calls = calls
    return sleep
