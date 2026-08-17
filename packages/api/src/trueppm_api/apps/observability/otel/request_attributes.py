"""``trueppm.*`` identity attributes on the HTTP server span (#2880).

Five of the span keys :mod:`.attributes` publishes as an additive-only, cross-repo
contract had **zero** emit sites: nothing on any span named the acting user, their
role, or the project / program / task a request addressed. A collector-side
processor keyed on ``trueppm.task.id`` therefore never fired, and the test that
looked like coverage only asserted the constants started with ``trueppm.``. This
module is the missing emitter, wired as the Django instrumentor's ``response_hook``
so it runs once per request while the server span is still recording.

Three properties are load-bearing:

1. **No extra query, ever.** Resource ids come from the URL route Django already
   resolved. The role comes from the RBAC layer's per-request role cache, which the
   permission classes populated while authorizing this very request. The user comes
   from the request only when it is *already* resolved — a
   ``SimpleLazyObject`` that no view dereferenced is left alone, because forcing it
   would add a session/DB round trip to a request that never needed one. Telemetry
   that changes the query count is not observability.
2. **Absent beats wrong.** Every mapping here is exact. A route whose collection
   segment is not one of the three known ones contributes nothing rather than a
   guess — ``project-templates/<pk>`` is not a project, and ``task-relations/<pk>``
   is not a task. ``trueppm.user.role`` is only set when a single project (or a
   single program) was authorized, because TruePPM roles are project-scoped
   (ADR-0072) and a list endpoint spanning many projects has no one role.
3. **Never raises.** The upstream hook wraps this in try/except and logs, but a
   telemetry helper that can throw inside a response path is a latent 500 — so the
   guards are here too, and a failure degrades to a span with fewer attributes.

Privacy: ``trueppm.user.*`` carries the opaque primary key and the symbolic role and
nothing else — no email, username, display name, or client IP. Operators who must
not export a per-user identifier at all set
``TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED=false`` (Helm:
``observability.otlp.actorAttributes``), which drops both ``trueppm.user.*`` keys and
leaves the resource ids in place.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from django.conf import settings
from django.utils.functional import empty

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    PROGRAM_RBAC_ROLE_CACHE_ATTR,
    RBAC_ROLE_CACHE_ATTR,
)
from trueppm_api.apps.observability.otel import attributes

logger = logging.getLogger(__name__)

#: URL kwargs that name a resource unambiguously, whatever route they appear on.
#: Only ``project_pk`` and ``program_pk`` are in use today; the ``*_id`` spellings
#: are accepted so a future nested route does not silently stop being annotated.
_EXPLICIT_KWARG_ATTRS: dict[str, str] = {
    "project_pk": attributes.PROJECT_ID,
    "project_id": attributes.PROJECT_ID,
    "program_pk": attributes.PROGRAM_ID,
    "program_id": attributes.PROGRAM_ID,
    "task_pk": attributes.TASK_ID,
    "task_id": attributes.TASK_ID,
}

#: Collection segments whose bare ``<pk>`` IS the named resource. Exact strings, not
#: prefixes: ``project-templates``, ``project-resources``, ``task-relations`` and
#: ``task-resources`` are all separate collections whose pk is NOT a project or task
#: id, and a prefix match would mislabel every one of them.
_PK_COLLECTION_ATTRS: dict[str, str] = {
    "projects": attributes.PROJECT_ID,
    "programs": attributes.PROGRAM_ID,
    "tasks": attributes.TASK_ID,
}

#: The collection segment immediately preceding a ``pk`` capture in a resolved
#: route. Matches both shapes Django reports: the DRF router's regex
#: (``projects/(?P<pk>[^/.]+)/``) and a ``path()`` converter (``projects/<pk>/``,
#: ``projects/<uuid:pk>/``). A leading ``^`` from a concatenated sub-resolver
#: pattern sits outside the captured group, so it does not interfere.
_PK_COLLECTION_RE = re.compile(r"([a-z][a-z-]*)/(?:\(\?P<pk>|<(?:[a-z_]+:)?pk>)")


def _actor_attributes_enabled() -> bool:
    """Whether ``trueppm.user.*`` may be exported (privacy lever, default on)."""
    return bool(getattr(settings, "TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED", True))


def _resolved_user(request: Any) -> Any | None:
    """Return the request's user only if it has ALREADY been resolved.

    ``AuthenticationMiddleware`` installs ``request.user`` as a
    :class:`~django.utils.functional.SimpleLazyObject` that hits the session store
    on first access. DRF replaces it with the concrete user once a view
    authenticates, so on the API surface this is a plain attribute read. On a route
    that never touched ``request.user``, dereferencing it *here* would add a query
    that exists only because telemetry is on — so an unevaluated lazy object is
    treated as "no user".
    """
    user = request.__dict__.get("user")
    if user is None:
        return None
    if getattr(user, "_wrapped", None) is empty:
        return None
    if not getattr(user, "is_authenticated", False):
        return None
    return user


def _role_label(ordinal: int) -> str | None:
    """Map a role ordinal to a low-cardinality symbolic label.

    An exact OSS tier returns its name (``VIEWER`` … ``OWNER``). An Enterprise custom
    role registered at an intermediate ordinal (ADR-0072 reserves the 100-unit bands
    for exactly that) has no OSS name, so it returns its band with a ``+`` marker —
    ``SCHEDULER+`` for 250 — which keeps the dimension bounded at ten values while
    making the approximation visible instead of dropping the attribute for those
    users, which would be the same silence this module exists to remove.
    """
    try:
        return str(Role(ordinal).name)
    except ValueError:
        pass
    band = max((r for r in Role if r.value <= ordinal), default=None, key=lambda r: r.value)
    return f"{band.name}+" if band is not None else None


def _sole_cached_role(request: Any) -> str | None:
    """The role this request was authorized under, if exactly one is well defined.

    Reads the caches the permission classes filled while authorizing this request
    (``_rbac_role_cache`` / ``_program_rbac_role_cache``, keyed by resource id), so
    it adds no query. Project scope wins when both are populated. Anything other
    than a single non-``None`` entry yields ``None``: a list endpoint that checked
    forty projects has forty roles and no single answer, and an arbitrary pick would
    be worse than an absent attribute.
    """
    for attr in (RBAC_ROLE_CACHE_ATTR, PROGRAM_RBAC_ROLE_CACHE_ATTR):
        cache = getattr(request, attr, None)
        if not isinstance(cache, dict):
            continue
        roles = [value for value in cache.values() if value is not None]
        if len(roles) == 1 and len(cache) == 1:
            return _role_label(int(roles[0]))
    return None


def _resource_ids(request: Any) -> dict[str, str]:
    """Resource-identity attributes derivable from the route Django resolved."""
    match = getattr(request, "resolver_match", None)
    if match is None:
        return {}
    kwargs: dict[str, Any] = getattr(match, "kwargs", None) or {}
    found: dict[str, str] = {}

    for name, value in kwargs.items():
        key = _EXPLICIT_KWARG_ATTRS.get(name)
        if key is not None and value not in (None, ""):
            found[key] = str(value)

    pk = kwargs.get("pk")
    if pk not in (None, ""):
        route = str(getattr(match, "route", "") or "")
        segment = _PK_COLLECTION_RE.search(route)
        if segment is not None:
            key = _PK_COLLECTION_ATTRS.get(segment.group(1))
            # A nested route's own project_pk is more specific than the bare pk of
            # the collection it hangs off, so never overwrite an explicit kwarg.
            if key is not None and key not in found:
                found[key] = str(pk)
    return found


def annotate_request_span(span: Any, request: Any, _response: Any = None) -> None:
    """Attach the ``trueppm.*`` identity attributes to an HTTP server span.

    Wired as ``DjangoInstrumentor(response_hook=...)``, so it fires after the view
    has run — which is what makes the acting user and the authorized role available
    at all — and before the span ends.

    Args:
        span: The recording server span. ``None`` or a non-recording span is a no-op.
        request: The Django ``HttpRequest``. The DRF wrapper is not used: only the
            underlying request survives into ``process_response``.
        _response: The response, unused. Status and duration are the instrumentor's.
    """
    try:
        if span is None or not span.is_recording():
            return
        for key, value in _resource_ids(request).items():
            span.set_attribute(key, value)
        if not _actor_attributes_enabled():
            return
        user = _resolved_user(request)
        if user is not None and getattr(user, "pk", None) is not None:
            span.set_attribute(attributes.USER_ID, str(user.pk))
        role = _sole_cached_role(request)
        if role is not None:
            span.set_attribute(attributes.USER_ROLE, role)
    except Exception:
        # A response-path helper that can raise is a latent 500. Telemetry degrades.
        logger.debug("OpenTelemetry request-span annotation failed", exc_info=True)
