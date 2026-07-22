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
        # NAT64 well-known prefix wrapping cloud metadata (#900): a9fe:a9fe =
        # 169.254.169.254. is_global is True for the wrapper, so this only blocks
        # once the embedded IPv4 is unwrapped and re-checked.
        "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
    ],
)
def test_blocks_internal_addresses(url: str) -> None:
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed(url)


def test_allows_public_literal_ip() -> None:
    # Public, globally-routable literal — no DNS, no raise.
    http.assert_url_allowed("https://8.8.8.8/")


@pytest.mark.parametrize(
    "addr",
    [
        "64:ff9b::a9fe:a9fe",  # NAT64-wrapped 169.254.169.254 (metadata)
        "64:ff9b::a00:5",  # NAT64-wrapped 10.0.0.5 (RFC1918)
        "::ffff:169.254.169.254",  # IPv4-mapped metadata
        "::ffff:10.0.0.5",  # IPv4-mapped RFC1918
        "2002:a9fe:a9fe::",  # 6to4-wrapped 169.254.169.254
        "::169.254.169.254",  # IPv4-compatible (deprecated ::/96) metadata
        "::a9fe:a9fe",  # IPv4-compatible metadata, hex form
        "::a00:5",  # IPv4-compatible RFC1918 (10.0.0.5)
    ],
)
def test_blocks_ipv4_in_ipv6_transition_forms(addr: str) -> None:
    # #900: each wrapper reports is_global True, but the embedded IPv4 is
    # private/metadata — the guard must unwrap and reject it.
    import ipaddress

    assert http._is_blocked_ip(ipaddress.ip_address(addr)) is True


def test_allows_nat64_wrapped_public_ipv4() -> None:
    # NAT64-wrapping a *public* IPv4 (8.8.8.8) must still be allowed — the guard
    # checks the embedded target, it does not blanket-block the prefix.
    import ipaddress

    assert http._is_blocked_ip(ipaddress.ip_address("64:ff9b::808:808")) is False


def test_literal_ip_host_is_classified_without_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A literal-IP host is denied/allowed without touching ``getaddrinfo`` (#1628).

    The guard's rejection of a literal SSRF target (cloud metadata, RFC1918)
    must be a pure computation with no resolver involvement — otherwise a
    constrained CI network namespace can turn the deny into a transient
    ``EgressError`` and the caller retries into a real connection. Blow up if
    ``getaddrinfo`` is reached for any literal IP.
    """

    def _boom(*args: object, **kwargs: object) -> Any:
        raise AssertionError("getaddrinfo must not be called for a literal IP")

    monkeypatch.setattr(http.socket, "getaddrinfo", _boom)

    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http://169.254.169.254/latest/meta-data/")
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http://[::1]/")
    # IPv6-tunneled IPv4 literals must be unwrapped and blocked on the fast path
    # too (guards a future refactor that skips _embedded_ipv4 in the short-circuit).
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http://[64:ff9b::a9fe:a9fe]/")  # NAT64 -> 169.254.169.254
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http://[::ffff:10.0.0.5]/")  # IPv4-mapped RFC1918
    # A public literal returns without resolving.
    http.assert_url_allowed("https://8.8.8.8/")
    # assert_host_allowed (SMTP relay) shares the short-circuit.
    with pytest.raises(http.EgressBlocked):
        http.assert_host_allowed("10.0.0.5", 25)
    http.assert_host_allowed("8.8.8.8", 25)


# ---------------------------------------------------------------------------
# Operator allow-list (ADR-0590) — EGRESS_ALLOWLISTED_HOSTS bypasses the
# private-address deny-list for a trusted internal host (e.g. in-cluster IdP).
# ---------------------------------------------------------------------------


def test_allowlisted_host_bypasses_private_deny(
    monkeypatch: pytest.MonkeyPatch, settings: Any
) -> None:
    """An allow-listed hostname is admitted even though it resolves privately.

    A bare hostname (not an IP literal) goes through the resolver path, so the
    allow-list must short-circuit *before* resolution — proven here by making
    ``getaddrinfo`` blow up if it is reached.
    """
    settings.EGRESS_ALLOWLISTED_HOSTS = ["keycloak"]

    def _boom(*args: object, **kwargs: object) -> Any:
        raise AssertionError("allow-listed host must not be resolved")

    monkeypatch.setattr(http.socket, "getaddrinfo", _boom)
    # Both guards honor the allow-list; port is irrelevant (host-level trust).
    http.assert_url_allowed("http://keycloak:8080/realms/ci/.well-known/openid-configuration")
    http.assert_host_allowed("keycloak", 8080)


def test_allowlist_match_is_case_insensitive(settings: Any) -> None:
    settings.EGRESS_ALLOWLISTED_HOSTS = ["KeyCloak"]
    http.assert_url_allowed("http://keycloak:8080/")


def test_allowlist_is_exact_not_suffix(monkeypatch: pytest.MonkeyPatch, settings: Any) -> None:
    """Allow-listing ``keycloak`` must NOT admit a lookalike like ``keycloak.evil``.

    A non-exact host is not bypassed: it still goes through the resolver + address
    deny-list. Here the lookalike resolves to a private IP, so the guard blocks it —
    proving the allow-list did not suffix-match.
    """
    settings.EGRESS_ALLOWLISTED_HOSTS = ["keycloak"]

    def _resolves_private(*args: object, **kwargs: object) -> Any:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 8080))]

    monkeypatch.setattr(http.socket, "getaddrinfo", _resolves_private)
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http://keycloak.evil.example:8080/")


def test_allowlist_still_enforces_scheme(settings: Any) -> None:
    """The allow-list bypasses the address deny-list, not the scheme gate."""
    settings.EGRESS_ALLOWLISTED_HOSTS = ["keycloak"]
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("file://keycloak/etc/passwd")


def test_empty_allowlist_is_default_posture(settings: Any) -> None:
    """With no allow-list, a private host is blocked exactly as before."""
    settings.EGRESS_ALLOWLISTED_HOSTS = []
    with pytest.raises(http.EgressBlocked):
        http.assert_url_allowed("http://10.0.0.5/")


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
