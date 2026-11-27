"""Behavior of the regexes in the shipped nginx configs (#5155, #3852).

Headers and ``limit_req`` presence are asserted by
``scripts/check-nginx-security-headers.sh``. What that gate cannot say is whether
a regex matches what it is meant to: that the access-log ``map`` removes a share
token, and that the auth rate-limit location covers real URLs and nothing the SPA
calls while signed in.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from django.urls import resolve

REPO_ROOT = Path(__file__).resolve().parents[4]

#: Config file -> number of ``default.conf`` renderings it carries.
CONFIGS = {
    "nginx/app.conf.template": 1,
    "nginx/app-http.conf.template": 1,
    "nginx/demo.conf.template": 1,
    "packages/web/nginx.conf": 1,
    "packages/helm/templates/web/configmap.yaml": 3,
}

_MAP_ENTRY = re.compile(
    r'^\s*"~\*(?P<pattern>[^"]+)"\s+"\$trueppm_(?P<kind>req|ref)_head\[redacted\]'
    r'\$trueppm_(?P=kind)_tail";$',
    re.MULTILINE,
)


def _redact(pattern: str, kind: str, value: str) -> str:
    """Apply one nginx map entry (PCRE ``(?<n>)`` spelled Python's way)."""
    match = re.search(pattern.replace("(?<", "(?P<"), value, re.IGNORECASE)
    if not match:
        return value
    return f"{match[f'trueppm_{kind}_head']}[redacted]{match[f'trueppm_{kind}_tail']}"


@pytest.mark.parametrize("rel", CONFIGS)
def test_share_tokens_are_redacted_from_the_access_log(rel: str) -> None:
    text = (REPO_ROOT / rel).read_text(encoding="utf-8")
    entries = _MAP_ENTRY.findall(text)
    assert sorted(kind for _, kind in entries) == sorted(["req", "ref"] * CONFIGS[rel])
    # The format must log the mapped values, never the raw request line or Referer.
    for fmt in re.findall(r"log_format trueppm_redacted [^;]+;", text):
        assert "$trueppm_log_request" in fmt and "$trueppm_log_referer" in fmt
        assert not re.search(r"\$(request|request_uri|http_referer)\b", fmt)
    assert text.count("log_format trueppm_redacted ") == CONFIGS[rel]

    token = "Zr8-secret_TOKEN"
    for pattern, kind in entries:
        for value in (
            f"GET /share/board/{token} HTTP/1.1",
            f"GET /share/status-update/{token}?utm=1 HTTP/1.1",
            f"GET /api/v1/share/schedule/{token}/ HTTP/2.0",
            f"https://pm.example.com/Share/Board/{token}",
        ):
            redacted = _redact(pattern, kind, value)
            assert token not in redacted, f"{rel}: {value!r} -> {redacted!r}"
            assert "[redacted]" in redacted
        for untouched in (
            "GET /api/v1/projects/abc/share-links/ HTTP/1.1",
            "GET /projects/abc/schedule HTTP/1.1",
        ):
            assert _redact(pattern, kind, untouched) == untouched


#: Unauthenticated auth routes the edge rate limit must cover (#3852).
_RATE_LIMITED_PATHS = (
    "/api/v1/auth/token/",
    "/api/v1/auth/token/refresh/",
    "/api/v1/auth/logout/",
    "/api/v1/auth/password/reset/",
    "/api/v1/auth/password/reset/confirm/",
    "/api/v1/auth/oidc/discover/",
    "/api/v1/auth/oidc/login/",
    "/api/v1/auth/oidc/callback/",
    "/api/v1/workspace/invites/accept/",
)

#: Authenticated, frequently called routes it must never catch.
_UNLIMITED_PATHS = (
    "/api/v1/auth/me/",
    "/api/v1/auth/me/profile/",
    "/api/v1/workspace/invites/",
    "/api/v1/projects/",
)


@pytest.mark.parametrize(
    "rel",
    [
        "nginx/app.conf.template",
        "nginx/app-http.conf.template",
        "packages/helm/templates/web/configmap.yaml",
    ],
)
def test_edge_rate_limit_covers_real_auth_routes_only(rel: str) -> None:
    """A renamed auth URL would otherwise leave the nginx regex limiting nothing."""
    text = (REPO_ROOT / rel).read_text(encoding="utf-8")
    patterns = re.findall(r"^\s*location ~ (\^/api/v1/\(auth/\S+) \{$", text, re.MULTILINE)
    assert len(patterns) == 1, f"{rel}: expected one auth rate-limit location"
    for path in _RATE_LIMITED_PATHS:
        resolve(path)
        assert re.search(patterns[0], path), f"{rel}: {path} is not rate limited"
    for path in _UNLIMITED_PATHS:
        assert not re.search(patterns[0], path), f"{rel}: {path} must not be rate limited"


@pytest.mark.parametrize(
    ("rel", "peer_keyed"),
    [
        ("nginx/app.conf.template", True),
        ("nginx/app-http.conf.template", False),
        ("nginx/demo.conf.template", None),
        ("packages/web/nginx.conf", None),
    ],
)
def test_edge_rate_limit_keys_on_a_client_address_only(rel: str, peer_keyed: bool | None) -> None:
    """A per-address limit behind a proxy is one shared bucket for every user (#3852).

    Only the TLS template, which terminates the client's own connection, may key
    on the peer address. app-http sits behind a load balancer and keys on
    ``$trueppm_rl_key``, which is empty (uncounted) unless the peer is
    NGINX_TRUSTED_PROXY_CIDR. The demo and the baked image cannot tell clients
    apart at all and declare no edge zone, leaving the DRF throttles.
    """
    text = (REPO_ROOT / rel).read_text(encoding="utf-8")
    keys = set(re.findall(r"^limit_req_zone (\$\w+) zone=trueppm_", text, re.MULTILINE))
    if peer_keyed is None:
        assert not keys, f"{rel} declares an edge zone it cannot key on a client"
        assert "zone=trueppm_" not in text
    elif peer_keyed:
        assert keys == {"$binary_remote_addr"}
    else:
        assert keys == {"$trueppm_rl_key"}
        assert "${NGINX_TRUSTED_PROXY_CIDR} 1;" in text
