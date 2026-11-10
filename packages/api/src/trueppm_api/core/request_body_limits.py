"""Per-route request-body ceilings — the one table the nginx configs mirror (#4383).

Before this, one process-wide ``DATA_UPLOAD_MAX_MEMORY_SIZE`` of 100 MB, sized for
multipart attachments, was also the largest JSON body every endpoint would parse —
including the unauthenticated ones (token obtain, invite accept, password reset,
OIDC, share). DRF reads a JSON body through ``request.body``, so that setting *is*
the JSON ceiling, and each request in a throttle window cost a full ``json.loads``
of up to 100 MB before any credential was checked.

The posture now has three tiers:

- **default** — every route not listed below. 2 MiB, which is also the global
  ``DATA_UPLOAD_MAX_MEMORY_SIZE`` (a test pins the two together).
- **bulk** — routes that legitimately take a JSON (or small-file) body larger
  than 2 MiB: offline sync push, task bulk, inbound task push, the seed import and
  its dry run, and the workspace logo. 10 MiB for the whole body *and* for the
  parsed JSON.
- **upload** — multipart file imports and attachments. 110 MiB for the whole
  body (the 100 MB attachment cap plus multipart framing), but the parsed-JSON
  ceiling stays at the default: Django streams *file* parts through the upload
  handlers (memory up to ``FILE_UPLOAD_MAX_MEMORY_SIZE``, then a temp file), and
  ``DATA_UPLOAD_MAX_MEMORY_SIZE`` only ever counts the non-file fields. So a
  100 MB file is fine while a 100 MB JSON body on the same route is still refused.

Each feature keeps its own, narrower cap (``MSPROJECT_MAX_UPLOAD_MB``,
``SEED_MAX_UPLOAD_MB``, the attachment serializer's 100 MB …) and that cap is what
names the limit in its error. The tier is the transport ceiling above it.

Two enforcement points read this table:

- :class:`RequestBodyLimitMiddleware` refuses a declared ``Content-Length`` over
  the route's ceiling with ``413`` before the session, auth, or the view's
  ``ATOMIC_REQUESTS`` transaction runs. It is application-side on purpose: the
  default Helm topology sends ``/api/`` from the Ingress straight to the API
  Service, so the web tier's per-location ``client_max_body_size`` is not in the
  path at all there.
- The same middleware raises the parsed-body ceiling for **bulk** routes, by
  reading the body itself under the route's bound (see
  :func:`_prime_body`), because ``DATA_UPLOAD_MAX_MEMORY_SIZE`` is a single global
  with no per-view override.

The four nginx configs carry the same tiers as per-location
``client_max_body_size``; ``tests/core/test_request_body_limits.py`` parses each
one and fails if a route's nginx size disagrees with its tier here.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO

from django.conf import settings
from django.http import HttpRequest, HttpResponse, JsonResponse

_MIB = 1024 * 1024


@dataclass(frozen=True)
class BodyTier:
    """A transport ceiling shared by a group of routes.

    Attributes:
        name: Stable identifier, used by the nginx-drift test.
        max_body_bytes: Ceiling on the declared ``Content-Length`` of the whole
            request (all multipart parts included). nginx carries the same value.
        max_parsed_bytes: Ceiling on a body Django reads into memory and parses
            (JSON, urlencoded, multipart non-file fields).
        nginx_size: The literal ``client_max_body_size`` value the nginx
            configs must carry for this tier.
    """

    name: str
    max_body_bytes: int
    max_parsed_bytes: int
    nginx_size: str


DEFAULT_TIER = BodyTier("default", 2 * _MIB, 2 * _MIB, "2M")
BULK_TIER = BodyTier("bulk", 10 * _MIB, 10 * _MIB, "10M")
UPLOAD_TIER = BodyTier("upload", 110 * _MIB, 2 * _MIB, "110M")


@dataclass(frozen=True)
class LargeBodyRoute:
    """One route that is allowed a body above the default tier.

    Attributes:
        name: Human-readable identifier.
        pattern: Anchored regex matched against ``request.path_info``.
        example: A concrete path the pattern (and the nginx location) must match.
        tier: The ceiling this route gets.
    """

    name: str
    pattern: re.Pattern[str]
    example: str
    tier: BodyTier


def _route(name: str, pattern: str, example: str, tier: BodyTier) -> LargeBodyRoute:
    return LargeBodyRoute(name, re.compile(pattern), example, tier)


#: Every route allowed a body above 2 MiB. Adding a row here without adding the
#: path to the matching nginx location in all four configs fails
#: ``test_request_body_limits.py`` — that is the point of keeping one table.
LARGE_BODY_ROUTES: tuple[LargeBodyRoute, ...] = (
    # --- upload tier: multipart file parts -------------------------------
    _route(
        "task attachment upload",
        r"^/api/v1/projects/[^/]+/tasks/[^/]+/attachments/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/tasks/00000000-0000-4000-8000-000000000002/attachments/",
        UPLOAD_TIER,
    ),
    _route(
        "MS Project import",
        r"^/api/v1/projects/[^/]+/import/msproject/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/import/msproject/",
        UPLOAD_TIER,
    ),
    _route(
        "create project from MS Project",
        r"^/api/v1/projects/import/msproject/$",
        "/api/v1/projects/import/msproject/",
        UPLOAD_TIER,
    ),
    _route(
        "Jira XML import",
        r"^/api/v1/projects/[^/]+/import/jira/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/import/jira/",
        UPLOAD_TIER,
    ),
    _route(
        "CSV/Excel import",
        r"^/api/v1/projects/[^/]+/import/csv/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/import/csv/",
        UPLOAD_TIER,
    ),
    _route(
        "CSV/Excel import preview",
        r"^/api/v1/projects/[^/]+/import/csv/preview/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/import/csv/preview/",
        UPLOAD_TIER,
    ),
    _route(
        "risk CSV import",
        r"^/api/v1/projects/[^/]+/risks/import/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/risks/import/",
        UPLOAD_TIER,
    ),
    # --- bulk tier: large JSON bodies and small files ------------------------
    _route(
        "workspace logo upload",
        r"^/api/v1/workspace/logo/$",
        "/api/v1/workspace/logo/",
        BULK_TIER,
    ),
    _route(
        "program seed import",
        r"^/api/v1/programs/import/$",
        "/api/v1/programs/import/",
        BULK_TIER,
    ),
    _route(
        "program seed dry run",
        r"^/api/v1/programs/import/validate/$",
        "/api/v1/programs/import/validate/",
        BULK_TIER,
    ),
    _route(
        "task bulk operations",
        r"^/api/v1/projects/[^/]+/tasks/bulk/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/tasks/bulk/",
        BULK_TIER,
    ),
    _route(
        "offline sync push",
        r"^/api/v1/projects/[^/]+/sync/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/sync/",
        BULK_TIER,
    ),
    _route(
        "inbound task push",
        r"^/api/v1/projects/[^/]+/task-sync/$",
        "/api/v1/projects/00000000-0000-4000-8000-000000000001/task-sync/",
        BULK_TIER,
    ),
)


def tier_for_path(path: str) -> BodyTier:
    """Return the body tier that governs ``path`` (the default when unlisted)."""
    for route in LARGE_BODY_ROUTES:
        if route.pattern.match(path):
            return route.tier
    return DEFAULT_TIER


def _declared_length(request: HttpRequest) -> int | None:
    raw = request.META.get("CONTENT_LENGTH")
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _too_large(max_bytes: int) -> JsonResponse:
    return JsonResponse(
        {
            "detail": (
                f"Request body too large for this endpoint. Maximum: {max_bytes // _MIB} MB."
            ),
            "code": "request_body_too_large",
        },
        status=413,
    )


def _prime_body(request: HttpRequest, length: int) -> None:
    """Read a bulk-tier body ourselves so Django's global parse ceiling is not hit.

    ``DATA_UPLOAD_MAX_MEMORY_SIZE`` is read from settings on every ``request.body``
    access and has no per-view override, so a 5 MB seed document would be refused
    at 2 MiB however the view is configured. Reading the declared length here and
    caching it exactly as ``HttpRequest.body`` does (``_body`` plus a rewound
    ``_stream``) means every later reader — DRF's JSON parser, the idempotency
    hash, the seed importer's own byte check — sees the cached bytes and skips the
    global check. The caller has already bounded ``length`` by the route's tier,
    so this never reads more than the tier allows.

    Multipart bodies are never primed: their file parts must stream to the upload
    handlers rather than land in memory.
    """
    if hasattr(request, "_body"):
        return
    raw = request.read(length)
    request._body = raw  # mirrors HttpRequest.body's own cache
    request._stream = BytesIO(raw)


class RequestBodyLimitMiddleware:
    """Refuse an oversized declared body with ``413`` before any per-request work.

    Placed high in ``MIDDLEWARE`` — after the request-id and CSP middleware so the
    refusal still carries both, but before the session, auth and the view's
    ``ATOMIC_REQUESTS`` transaction, so an oversized request costs a header read and
    nothing else.

    Only the *declared* length is checked here. A body sent without
    ``Content-Length`` (chunked transfer-encoding) is not parsed by DRF at all — it
    sees an empty body — and any direct ``request.body`` reader is still bounded by
    ``DATA_UPLOAD_MAX_MEMORY_SIZE``.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        length = _declared_length(request)
        if length:
            tier = tier_for_path(request.path_info)
            if length > tier.max_body_bytes:
                return _too_large(tier.max_body_bytes)
            content_type = request.META.get("CONTENT_TYPE", "")
            if (
                tier.max_parsed_bytes > settings.DATA_UPLOAD_MAX_MEMORY_SIZE
                and length > settings.DATA_UPLOAD_MAX_MEMORY_SIZE
                and not content_type.startswith("multipart/")
            ):
                if length > tier.max_parsed_bytes:
                    return _too_large(tier.max_parsed_bytes)
                _prime_body(request, length)
        return self.get_response(request)
