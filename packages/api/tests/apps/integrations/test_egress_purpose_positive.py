"""Each caller's own allow-list still reaches its trusted internal host (#2851).

The static caller walk proves a ``purpose=`` is passed; these prove the REAL
guard (no ``assert_*`` stub) lets that purpose's list through, and that a list
for a different purpose does not. The host resolves to a private address, so only
the allow-list can account for a pass.
"""

from __future__ import annotations

import json
import socket
from typing import Any
from unittest.mock import patch

import pytest
from django.core.cache import cache

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.integrations import providers
from trueppm_api.apps.notifications import email_backend
from trueppm_api.apps.sso import services

HOST = "internal.corp.test"


@pytest.fixture(autouse=True)
def _private_resolution() -> Any:
    def fake(h: str, p: Any, *a: Any, **k: Any) -> list[Any]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", p or 0))]

    with patch.object(socket, "getaddrinfo", fake):
        yield


class _Resp:
    def __init__(self, body: bytes) -> None:
        self.status = 200
        self.headers: Any = type("H", (), {"items": lambda self: [("content-type", "x")]})()
        self._body = body

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *a: object) -> None:
        return None

    def read(self, n: int = -1) -> bytes:
        return self._body


class _Opener:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.opened = 0

    def open(self, req: Any, timeout: Any = None) -> _Resp:
        self.opened += 1
        return _Resp(self.body)


def test_smtp_save_succeeds_with_host_on_the_smtp_list(settings: Any) -> None:
    settings.EGRESS_ALLOWLISTED_HOSTS_SMTP = [HOST]
    email_backend._assert_host_public(HOST, 25)


def test_smtp_host_on_only_the_legacy_sso_list_is_refused(settings: Any) -> None:
    settings.EGRESS_ALLOWLISTED_HOSTS = [HOST]
    with pytest.raises(email_backend.EmailHostNotAllowedError):
        email_backend._assert_host_public(HOST, 25)


def test_pat_verify_gets_past_the_guard_with_host_on_the_integrations_list(
    settings: Any,
) -> None:
    settings.EGRESS_ALLOWLISTED_HOSTS_INTEGRATIONS = [HOST]
    opener = _Opener(json.dumps({"login": "octo"}).encode())
    with patch.object(egress, "_opener_for", lambda purpose: opener):
        result = providers._verify_via_user_endpoint(
            "tok", url=f"https://{HOST}/user", headers={}, username_key="login"
        )
    assert result.ok is True
    assert opener.opened == 1


def test_pat_verify_refuses_a_host_listed_only_for_sso(settings: Any) -> None:
    settings.EGRESS_ALLOWLISTED_HOSTS_SSO = [HOST]
    settings.EGRESS_ALLOWLISTED_HOSTS = [HOST]
    opener = _Opener(b"{}")
    with patch.object(egress, "_opener_for", lambda purpose: opener):
        result = providers._verify_via_user_endpoint(
            "tok", url=f"https://{HOST}/user", headers={}, username_key="login"
        )
    assert result.ok is False
    assert result.reason == "blocked_host"
    assert opener.opened == 0


def test_sso_discovery_still_reaches_a_host_on_the_legacy_list(settings: Any) -> None:
    """The issue's test-plan line: the SSO discovery path still reaches it."""
    cache.clear()
    settings.EGRESS_ALLOWLISTED_HOSTS = [HOST]
    issuer = f"https://{HOST}"
    doc = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/auth",
        "token_endpoint": f"{issuer}/token",
        "jwks_uri": f"{issuer}/jwks",
    }
    opener = _Opener(json.dumps(doc).encode())
    with patch.object(egress, "_opener_for", lambda purpose: opener):
        got = services.get_discovery_document(issuer)
    assert got["token_endpoint"] == f"{issuer}/token"
    assert opener.opened == 1
    cache.clear()
