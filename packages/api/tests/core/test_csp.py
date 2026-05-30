"""Content-Security-Policy middleware tests (#897).

Verifies the CSP header is attached to responses and carries the hardening
directives that matter most: a self-only default/script source,
``frame-ancestors 'none'`` (clickjacking), and ``base-uri 'none'``.
"""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

_HEADER = "Content-Security-Policy"


def _parse_directives(policy: str) -> dict[str, list[str]]:
    """Parse a CSP header string into a ``{directive: [sources]}`` mapping."""
    out: dict[str, list[str]] = {}
    for chunk in policy.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, *sources = chunk.split()
        out[name] = sources
    return out


@pytest.mark.django_db
def test_csp_header_present_on_response() -> None:
    # /health/ is unauthenticated and always 200 — a clean probe for response headers.
    resp = APIClient().get("/api/v1/health/")
    assert _HEADER in resp.headers


@pytest.mark.django_db
def test_csp_contains_expected_hardening_directives() -> None:
    resp = APIClient().get("/api/v1/health/")
    directives = _parse_directives(resp.headers[_HEADER])

    assert directives["default-src"] == ["'self'"]
    assert directives["script-src"] == ["'self'"]
    assert directives["frame-ancestors"] == ["'none'"]
    assert directives["base-uri"] == ["'none'"]
    assert directives["form-action"] == ["'self'"]
    # connect-src must allow the WebSocket collaboration channel.
    assert "wss:" in directives["connect-src"]
    assert "'self'" in directives["connect-src"]


@pytest.mark.django_db
def test_csp_build_policy_reflects_settings(settings) -> None:
    # Per-deploy override of connect-src should flow through to the header.
    settings.CSP_DIRECTIVES = {
        "default-src": ["'self'"],
        "connect-src": ["'self'", "wss://example.test"],
        "frame-ancestors": ["'none'"],
    }
    from trueppm_api.core.csp import _build_policy

    directives = _parse_directives(_build_policy())
    assert directives["connect-src"] == ["'self'", "wss://example.test"]
    assert directives["frame-ancestors"] == ["'none'"]
