"""Per-route request-body ceilings and their nginx mirrors (#4383, #2421).

Three things are pinned here:

1. The table itself: every listed route is a real URL, the global
   ``DATA_UPLOAD_MAX_MEMORY_SIZE`` equals the default tier, and every feature's own
   upload cap fits under the tier its route gets.
2. The middleware: an oversized declared body is refused with ``413`` before any
   view work, including on the unauthenticated login and invite routes, while a
   large upload on an upload-tier route and a large JSON body on a bulk-tier route
   are let through.
3. Drift: each of the four nginx configs carries the same per-route
   ``client_max_body_size`` as the table, parsed from the files themselves.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import Client, RequestFactory
from django.urls import Resolver404, resolve

from trueppm_api.core.request_body_limits import (
    BULK_TIER,
    DEFAULT_TIER,
    LARGE_BODY_ROUTES,
    UPLOAD_TIER,
    BodyTier,
    RequestBodyLimitMiddleware,
    tier_for_path,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
_MIB = 1024 * 1024
_P = "/api/v1/projects/00000000-0000-4000-8000-000000000001"
_T = "/tasks/00000000-0000-4000-8000-000000000002"
_MULTIPART = "multipart/form-data; boundary=x"

#: Real routes that must stay on the default tier. Includes the unauthenticated
#: surfaces the issue named, so a regex widened by accident is caught here.
DEFAULT_TIER_PATHS = (
    "/api/v1/auth/token/",
    "/api/v1/auth/password-reset/",
    "/api/v1/workspace/invites/accept/",
    f"{_P}/tasks/",
    f"{_P}{_T}/",
    "/api/v1/programs/",
    "/api/v1/programs/bulk-fields/",
)


# ---------------------------------------------------------------------------
# 1. The table
# ---------------------------------------------------------------------------


def test_global_parse_ceiling_is_the_default_tier() -> None:
    """The middleware and Django must agree on what an unlisted route may parse."""
    from trueppm_api.settings import base

    assert DEFAULT_TIER.max_parsed_bytes == base.DATA_UPLOAD_MAX_MEMORY_SIZE
    assert DEFAULT_TIER.max_parsed_bytes == settings.DATA_UPLOAD_MAX_MEMORY_SIZE
    assert DEFAULT_TIER.max_parsed_bytes <= 2 * _MIB


@pytest.mark.parametrize("route", LARGE_BODY_ROUTES, ids=lambda r: r.name)
def test_every_listed_route_is_a_real_url(route: object) -> None:
    """A row naming a path no view serves is a raised ceiling on nothing."""
    from trueppm_api.core.request_body_limits import LargeBodyRoute

    assert isinstance(route, LargeBodyRoute)
    assert route.pattern.match(route.example)
    assert tier_for_path(route.example) is route.tier
    try:
        resolve(route.example)
    except Resolver404:  # pragma: no cover - the assertion message is the point
        pytest.fail(f"{route.name}: {route.example} does not resolve to any view")


@pytest.mark.parametrize("path", DEFAULT_TIER_PATHS)
def test_unlisted_routes_get_the_default_tier(path: str) -> None:
    assert tier_for_path(path) is DEFAULT_TIER


def test_feature_caps_fit_under_their_routes_tier() -> None:
    """Each feature's own cap must be what refuses an oversized file, not the tier.

    The feature cap names the limit in its error; the tier is a bare ``413``. A
    default above its tier would make the documented limit unreachable.
    """
    from trueppm_api.apps.projects.serializers import MAX_ATTACHMENT_SIZE_BYTES
    from trueppm_api.apps.workspace.views import _LOGO_MAX_BYTES

    assert UPLOAD_TIER.max_body_bytes > MAX_ATTACHMENT_SIZE_BYTES
    for cap_mb in (
        settings.MSPROJECT_MAX_UPLOAD_MB,
        settings.JIRA_IMPORT_MAX_UPLOAD_MB,
        settings.CSV_IMPORT_MAX_UPLOAD_MB,
    ):
        assert cap_mb * _MIB < UPLOAD_TIER.max_body_bytes
    # The seed cap must fit under the bulk tier on BOTH transports (#2421): the
    # tier bounds the multipart file and the raw JSON body alike.
    assert BULK_TIER.max_parsed_bytes > settings.SEED_MAX_UPLOAD_MB * _MIB
    assert BULK_TIER.max_body_bytes > _LOGO_MAX_BYTES


# ---------------------------------------------------------------------------
# 2. The middleware
# ---------------------------------------------------------------------------


def _run(path: str, length: int, content_type: str, body: bytes = b"") -> HttpResponse:
    """Run the middleware with a declared length, without allocating the body."""
    request = RequestFactory().generic(
        "POST", path, data=body, content_type=content_type, CONTENT_LENGTH=str(length)
    )
    seen: list[HttpRequest] = []

    def view(req: HttpRequest) -> HttpResponse:
        seen.append(req)
        return HttpResponse(status=204)

    response = RequestBodyLimitMiddleware(view)(request)
    if response.status_code == 204:
        assert seen, "middleware returned the view's status without calling it"
    return response


@pytest.mark.parametrize(
    ("path", "length", "content_type", "expected"),
    [
        # Unauthenticated JSON routes: 5 MB used to be parsed in full.
        ("/api/v1/auth/token/", 5 * _MIB, "application/json", 413),
        ("/api/v1/workspace/invites/accept/", 5 * _MIB, "application/json", 413),
        ("/api/v1/auth/token/", 1 * _MIB, "application/json", 204),
        # A multipart body on a default route: file parts are not counted by
        # DATA_UPLOAD_MAX_MEMORY_SIZE, so the middleware is the only app bound.
        (f"{_P}/tasks/", 50 * _MIB, _MULTIPART, 413),
        # Upload tier: a 50 MB file passes; past the tier it does not.
        (f"{_P}{_T}/attachments/", 50 * _MIB, _MULTIPART, 204),
        (f"{_P}/import/msproject/", 111 * _MIB, _MULTIPART, 413),
        # Upload tier does NOT raise the JSON ceiling: only file parts get 110 MB.
        # (Django's own DATA_UPLOAD_MAX_MEMORY_SIZE refuses this one at parse
        # time; the middleware lets it through to that check.)
        (f"{_P}{_T}/attachments/", 1 * _MIB, "application/json", 204),
        # Bulk tier.
        (f"{_P}/sync/", 11 * _MIB, "application/json", 413),
    ],
)
def test_declared_length_is_refused_over_the_routes_tier(
    path: str, length: int, content_type: str, expected: int
) -> None:
    assert _run(path, length, content_type).status_code == expected


def test_refusal_names_the_ceiling() -> None:
    import json

    resp = _run("/api/v1/auth/token/", 5 * _MIB, "application/json")
    payload = json.loads(resp.content)
    assert payload["code"] == "request_body_too_large"
    assert "2 MB" in payload["detail"]


def test_bulk_route_json_above_the_global_ceiling_is_primed_for_the_parser() -> None:
    """A 3 MB JSON body on a bulk route must survive Django's 2 MiB parse check.

    ``request.body`` re-checks DATA_UPLOAD_MAX_MEMORY_SIZE on first access; the
    middleware reads the body under the bulk tier's bound and caches it, so the
    view's ``request.body`` (and therefore DRF's JSON parser) returns it instead of
    raising ``RequestDataTooBig``.
    """
    body = b'{"pad": "' + b"x" * (3 * _MIB) + b'"}'
    request = RequestFactory().post(f"{_P}/tasks/bulk/", data=body, content_type="application/json")
    captured: dict[str, bytes] = {}

    def view(req: HttpRequest) -> HttpResponse:
        captured["body"] = req.body
        return HttpResponse(status=204)

    assert RequestBodyLimitMiddleware(view)(request).status_code == 204
    assert captured["body"] == body


def test_multipart_on_a_bulk_route_is_never_primed() -> None:
    """File parts must stream to the upload handlers, never land in memory here."""
    request = RequestFactory().generic(
        "POST",
        "/api/v1/workspace/logo/",
        data=b"x" * (3 * _MIB),
        content_type=_MULTIPART,
    )
    primed: list[bool] = []

    def view(req: HttpRequest) -> HttpResponse:
        primed.append(hasattr(req, "_body"))
        return HttpResponse(status=204)

    assert RequestBodyLimitMiddleware(view)(request).status_code == 204
    assert primed == [False]


@pytest.mark.django_db
def test_middleware_is_installed_ahead_of_the_view() -> None:
    """End to end through the real stack: 5 MB at the login route answers 413."""
    resp = Client().post(
        "/api/v1/auth/token/", data=b"{" + b" " * (5 * _MIB) + b"}", content_type="application/json"
    )
    assert resp.status_code == 413


# ---------------------------------------------------------------------------
# 3. nginx drift
# ---------------------------------------------------------------------------

_LOCATION_RE = re.compile(r"^\s*location\s+~\s+(\S+)\s*\{\s*$")
_SIZE_RE = re.compile(r"^\s*client_max_body_size\s+(\S+);")


def _helm_upload_size() -> str:
    values = (REPO_ROOT / "packages/helm/values.yaml").read_text(encoding="utf-8")
    match = re.search(r"^\s+maxBodySize:\s*(\S+)\s*$", values, re.MULTILINE)
    assert match, "web.maxBodySize not found in values.yaml"
    return match.group(1)


def _nginx_text(rel: str) -> str:
    text = (REPO_ROOT / rel).read_text(encoding="utf-8")
    if rel.endswith("configmap.yaml"):
        # Only the production branch proxies the API generally; both demo branches
        # pin their own 1M ceiling and are fenced by other gates.
        text = text[text.index("{{- else }}\n  default.conf: |") :]
        text = text.replace('{{ .Values.web.maxBodySize | default "110M" }}', _helm_upload_size())
    return text


def _parse(text: str) -> tuple[str, list[tuple[re.Pattern[str], str]]]:
    """Return (server default size, [(location regex, size), ...])."""
    lines = text.splitlines()
    default: str | None = None
    located: list[tuple[re.Pattern[str], str]] = []
    for i, line in enumerate(lines):
        size = _SIZE_RE.match(line)
        if not size:
            continue
        loc = _LOCATION_RE.match(lines[i - 1]) if i else None
        if loc:
            located.append((re.compile(loc.group(1)), size.group(1)))
        else:
            assert default is None, "more than one server-level client_max_body_size"
            default = size.group(1)
    assert default is not None, "no server-level client_max_body_size"
    return default, located


def _nginx_tier_size(located: list[tuple[re.Pattern[str], str]], default: str, path: str) -> str:
    hits = [size for pattern, size in located if pattern.search(path)]
    assert len(hits) <= 1, f"{path} matches {len(hits)} body-size locations"
    return hits[0] if hits else default


NGINX_CONFIGS = (
    "nginx/app.conf.template",
    "nginx/app-http.conf.template",
    "packages/web/nginx.conf",
    "packages/helm/templates/web/configmap.yaml",
)


@pytest.mark.parametrize("rel", NGINX_CONFIGS)
def test_nginx_body_sizes_match_the_table(rel: str) -> None:
    default, located = _parse(_nginx_text(rel))
    assert default == DEFAULT_TIER.nginx_size, f"{rel}: server default is {default}"

    tiers: dict[str, BodyTier] = {t.name: t for t in (DEFAULT_TIER, BULK_TIER, UPLOAD_TIER)}
    for route in LARGE_BODY_ROUTES:
        got = _nginx_tier_size(located, default, route.example)
        assert got == tiers[route.tier.name].nginx_size, (
            f"{rel}: {route.name} ({route.example}) gets {got} at nginx, "
            f"table says {route.tier.nginx_size}"
        )
    for path in DEFAULT_TIER_PATHS:
        got = _nginx_tier_size(located, default, path)
        assert got == DEFAULT_TIER.nginx_size, f"{rel}: {path} gets {got}, expected default"


def test_nginx_sizes_are_at_least_the_django_ceilings() -> None:
    """nginx must never be the tighter bound — the app's refusal names the limit."""
    units = {"K": 1024, "M": _MIB, "G": 1024 * _MIB}
    for tier in (DEFAULT_TIER, BULK_TIER, UPLOAD_TIER):
        n = int(tier.nginx_size[:-1]) * units[tier.nginx_size[-1]]
        assert n >= tier.max_body_bytes
