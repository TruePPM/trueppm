"""Audit/security-log client IPs come from the throttle's resolution (#4023).

The leftmost ``X-Forwarded-For`` entry is written by the client. Every audit
writer used to record it, so an attacker could put any address they liked in
the forensic trail at every ``TRUEPPM_NUM_PROXIES`` value. These tests pin the
replacement: the recorded address is exactly what the per-IP throttles key on.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.conf import settings
from django.test import RequestFactory, override_settings

from trueppm_api.core.throttling import (
    ProbeExemptAnonRateThrottle,
    resolve_client_ident,
    resolve_client_ip,
)

SPOOFED = "6.6.6.6"
CLIENT = "93.184.216.34"
LB = "10.0.3.9"
POD_PEER = "10.42.0.17"


def _num_proxies(n: int) -> Any:
    return override_settings(REST_FRAMEWORK={**settings.REST_FRAMEWORK, "NUM_PROXIES": n})


def _request(xff: str | None, remote_addr: str = POD_PEER) -> Any:
    extra = {"REMOTE_ADDR": remote_addr}
    if xff is not None:
        extra["HTTP_X_FORWARDED_FOR"] = xff
    return RequestFactory().post("/api/v1/auth/login/", **extra)


@pytest.mark.parametrize(
    ("num_proxies", "expected"),
    [
        (0, POD_PEER),  # no trusted proxy: the header is ignored entirely
        (1, LB),  # one proxy: the entry it appended
        (2, CLIENT),  # LB -> ingress: the visitor the LB saw
    ],
)
def test_spoofed_leftmost_entry_is_never_recorded(num_proxies: int, expected: str) -> None:
    req = _request(f"{SPOOFED}, {CLIENT}, {LB}")
    with _num_proxies(num_proxies):
        assert resolve_client_ip(req) == expected
        assert resolve_client_ip(req) != SPOOFED


@pytest.mark.parametrize("num_proxies", [0, 1, 2, 3])
def test_recorded_address_equals_the_throttle_ident(num_proxies: int) -> None:
    """The audit trail and the throttle must never disagree about one request."""
    req = _request(f"{SPOOFED}, {CLIENT}, {LB}")
    with _num_proxies(num_proxies):
        assert resolve_client_ip(req) == ProbeExemptAnonRateThrottle().get_ident(req)


def test_falls_back_to_the_peer_without_a_header() -> None:
    with _num_proxies(1):
        assert resolve_client_ip(_request(None)) == POD_PEER


@pytest.mark.parametrize("junk", ["unknown", "1.2.3.4 user_id=1", "1.2.3.4:5678"])
def test_non_ip_resolution_is_none(junk: str) -> None:
    # Single-entry header at NUM_PROXIES=1 resolves to that entry verbatim; it must
    # not reach an inet column or a key=value log line unvalidated.
    with _num_proxies(1):
        req = _request(junk)
        assert resolve_client_ident(req) == junk
        assert resolve_client_ip(req) is None


def test_ipv6_is_normalized() -> None:
    with _num_proxies(1):
        assert resolve_client_ip(_request("2001:DB8:0:0:0:0:0:1")) == "2001:db8::1"


def test_only_the_throttling_module_parses_x_forwarded_for() -> None:
    """Recurrence guard: a new audit writer must call ``resolve_client_ip``.

    Five writers had each hand-rolled a leftmost-entry parse (#4023). Reading the
    header anywhere else reopens the class, so the source tree is checked for it.
    ``describe_client_address`` in ``core/throttling.py`` is the one legitimate
    reader — it echoes the raw chain to admins on purpose.
    """
    import pathlib

    import trueppm_api

    root = pathlib.Path(trueppm_api.__file__).parent
    allowed = {root / "core" / "throttling.py"}
    readers = sorted(
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if path not in allowed and "HTTP_X_FORWARDED_FOR" in path.read_text(encoding="utf-8")
    )
    assert readers == [], (
        f"{readers} read X-Forwarded-For directly; record client addresses with "
        "trueppm_api.core.throttling.resolve_client_ip instead"
    )
