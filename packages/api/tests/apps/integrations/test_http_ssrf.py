"""Unit tests for the SSRF-guarded egress helper (``integrations.http``, #677).

This is the single egress chokepoint shared by #677 PAT verification and #637
git-link refresh, so the SSRF policy is tested here once: scheme allow-list,
host presence, and the resolved-IP deny-list (private / loopback / link-local /
reserved). Literal IPs are used so ``getaddrinfo`` resolves them without DNS.
"""

from __future__ import annotations

import socket
import urllib.error
from typing import Any

import pytest

from trueppm_api.apps.integrations import http


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/file",
        "file:///etc/passwd",
        "gopher://example.com/",
        "javascript:alert(1)",
    ],
)
def test_rejects_non_http_schemes(url: str) -> None:
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed(url)


def test_rejects_missing_host() -> None:
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http:///nohost")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",  # loopback
        "https://127.0.0.1:8443/",  # loopback, non-default port
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://10.0.0.5/",  # RFC1918
        "http://192.168.0.1/",  # RFC1918
        "http://172.16.5.5/",  # RFC1918
        "http://[::1]/",  # IPv6 loopback
        "http://0.0.0.0/",  # unspecified
    ],
)
def test_blocks_internal_addresses(url: str) -> None:
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed(url)


def test_allows_public_literal_ip() -> None:
    # Public, globally-routable literal — no DNS, no raise.
    http.assert_url_allowed("https://8.8.8.8/")


def test_unresolvable_host_raises_egress_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*args: object, **kwargs: object) -> Any:
        raise socket.gaierror("name or service not known")

    monkeypatch.setattr(http.socket, "getaddrinfo", _boom)
    with pytest.raises(http.EgressError):
        http.assert_url_allowed("https://does-not-exist.invalid/")


# ---------------------------------------------------------------------------
# get() — transport mapping (guard passes via a public literal IP)
# ---------------------------------------------------------------------------


class _FakeResp:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body
        self.headers: dict[str, str] = {"Content-Type": "application/json"}

    def __enter__(self) -> _FakeResp:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, n: int = -1) -> bytes:
        return self._body


def test_get_returns_response_on_200(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http._opener, "open", lambda req, timeout: _FakeResp(200, b'{"ok": true}'))
    resp = http.get("https://8.8.8.8/")
    assert resp.status == 200
    assert resp.json() == {"ok": True}


def test_get_returns_http_error_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-2xx is returned, not raised, so callers can read a 401/403."""

    def _raise(req: object, timeout: float) -> Any:
        raise urllib.error.HTTPError("https://8.8.8.8/", 401, "Unauthorized", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(http._opener, "open", _raise)
    resp = http.get("https://8.8.8.8/")
    assert resp.status == 401


def test_get_maps_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(req: object, timeout: float) -> Any:
        raise TimeoutError("timed out")

    monkeypatch.setattr(http._opener, "open", _raise)
    with pytest.raises(http.EgressTimeout):
        http.get("https://8.8.8.8/")


def test_get_maps_urlerror_to_egress_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(req: object, timeout: float) -> Any:
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(http._opener, "open", _raise)
    with pytest.raises(http.EgressError):
        http.get("https://8.8.8.8/")


def test_get_blocks_before_opening_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guard runs before any socket work — a blocked URL never reaches the opener."""

    def _should_not_run(*args: object, **kwargs: object) -> Any:
        raise AssertionError("opener.open must not be called for a blocked URL")

    monkeypatch.setattr(http._opener, "open", _should_not_run)
    with pytest.raises(http.EgressBlocked):
        http.get("http://169.254.169.254/")
