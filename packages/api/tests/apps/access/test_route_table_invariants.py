"""Route-table invariants that pin the write surface before 0.4 tags (#2772).

Read/write agent governance is 0.5 work (#2745, #2749). That scope call is only
defensible if 0.4 ships with the write surface **pinned** — so the set of routes
0.5 has to govern is an asserted list rather than something the next audit
rediscovers.

Two invariants, both driven off ``get_resolver()`` so they see the routes the
application actually serves rather than what a source grep suggests.

**Why this cannot be a coverage target.** Measured on the refusal paths,
``task_bulk.py`` sits at 81% and ``permissions.py`` at 61% — and ``task_bulk.py``
could be at 100% while still recording nothing, because the #2749 defect is an
*absent call*. Coverage counts lines that exist. These are assertions about lines
that do not, which is the only place this class of defect lives.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path
from typing import Any

from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.viewsets import ViewSetMixin

from trueppm_api.apps.access import permissions as permissions_module
from trueppm_api.apps.projects.authentication import OwnerScopedApiTokenAuthentication

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# DRF's format-suffix routes (`…/foo.json`) duplicate every router route and add
# nothing to the surface — same view, same permissions, same methods. Dropping
# them keeps the pinned inventory reviewable instead of doubling it with noise.
_FORMAT_SUFFIX = re.compile(r"\\\.\(\?P<format>[^)]*\)/\?\$?$")

# A path segment that identifies a project: `projects/<x>` in either path() or
# re_path() form. This — not "any route with a project-scoped permission class" —
# is the shape the #2745 defect lives in: the URL names a project, so a reviewer
# reads the route as project-gated, while `_project_pk_from_view` reads only the
# literal kwarg name `project_pk` and returns None for anything else.
_PROJECT_SEGMENT = re.compile(r"projects/(?:<(?:[a-z]+:)?(?P<name>\w+)>|\(\?P<(?P<rname>\w+)>)")

TOKEN_WRITE_SURFACE_FILE = Path(__file__).parent / "token_write_surface.txt"


# ---------------------------------------------------------------------------
# Route-table walking
# ---------------------------------------------------------------------------


def _walk(resolver: Any = None, prefix: str = "") -> list[tuple[str, URLPattern]]:
    resolver = resolver if resolver is not None else get_resolver()
    out: list[tuple[str, URLPattern]] = []
    for entry in resolver.url_patterns:
        path = prefix + str(entry.pattern)
        if isinstance(entry, URLResolver):
            out.extend(_walk(entry, path))
        elif isinstance(entry, URLPattern):
            out.append((path, entry))
    return out


def _view_class(entry: URLPattern) -> type | None:
    """The view class behind a route, for both ``as_view()`` and ``@api_view``."""

    return getattr(entry.callback, "cls", None) or getattr(entry.callback, "view_class", None)


def _view_source(entry: URLPattern) -> str:
    """Source of the code that actually handles the request.

    Reads the class *and* the wrapped function, and concatenates them, because
    neither alone is sufficient:

    - a class-based view's logic is in the class, but ``as_view()`` sets
      ``__wrapped__`` to DRF's own inner ``view`` function (via ``csrf_exempt``'s
      ``functools.wraps``), so preferring ``__wrapped__`` would read DRF's source
      and miss ours entirely;
    - a function view decorated with ``@api_view`` has a generated
      ``WrappedAPIView`` class whose source is DRF's, and whose per-method handler
      is a DRF closure whose source is *also* DRF's. The original function is only
      reachable through that closure's cell — the module attribute of the same name
      is the *decorated* result (``as_view()``'s inner function), not the body.

    Concatenating is correct rather than lazy: this is a "does the gate exist"
    substring check, and DRF's own source contains neither idiom.
    """

    cls = _view_class(entry)
    targets: list[Any] = [cls, *_wrapped_function_views(cls)]

    sources = []
    for target in targets:
        if target is None:
            continue
        try:
            sources.append(inspect.getsource(target))
        except (OSError, TypeError):
            continue
    return "\n".join(sources)


def _wrapped_function_views(cls: type | None) -> list[Any]:
    """The original function(s) behind an ``@api_view``-generated ``WrappedAPIView``.

    ``api_view`` binds a ``handler`` closure onto the class for each HTTP method,
    and closes over the undecorated function. Reading the cell is the only way to
    reach the body; every other handle (the class, the handler, the module
    attribute) resolves to DRF's or Django's own source.
    """

    if cls is None:
        return []
    found = []
    for method in ("get", "post", "put", "patch", "delete"):
        handler = getattr(cls, method, None)
        for cell in getattr(handler, "__closure__", None) or ():
            try:
                contents = cell.cell_contents
            except ValueError:  # empty cell
                continue
            if inspect.isfunction(contents):
                found.append(contents)
    return found


def _project_scoped_permission_classes() -> set[str]:
    """Permission classes whose ``has_permission`` resolves a project from URL kwargs.

    Discovered by source inspection rather than hardcoded, so a *new* class written
    in the same shape is covered the day it is added — the failure mode a frozen
    list would miss.
    """

    found: set[str] = set()
    for name, obj in vars(permissions_module).items():
        if not (inspect.isclass(obj) and hasattr(obj, "has_permission")):
            continue
        try:
            source = inspect.getsource(obj)
        except (OSError, TypeError):
            continue
        if "_project_pk_from_view" in source:
            found.add(name)
    return found


def _project_identifying_routes() -> list[tuple[str, URLPattern, str, set[str]]]:
    """Routes whose URL names a project AND whose view declares a project-scoped class.

    Returns ``(path, entry, project_kwarg, declared_class_names)``.
    """

    scoped = _project_scoped_permission_classes()
    rows = []
    for path, entry in _walk():
        match = _PROJECT_SEGMENT.search(path)
        if match is None:
            continue
        cls = _view_class(entry)
        if cls is None:
            continue
        declared = {c.__name__ for c in getattr(cls, "permission_classes", [])} & scoped
        if not declared:
            continue
        kwarg = match.group("name") or match.group("rname")
        rows.append((path, entry, kwarg, declared))
    return rows


# ---------------------------------------------------------------------------
# Invariant 1 — every project-identifying route has an enforcement path
# ---------------------------------------------------------------------------

# The three legitimate ways a project-identifying route is enforced.
ENFORCED_BY_KWARG = "project_pk kwarg resolves in has_permission"
ENFORCED_BY_VIEWSET = "ViewSet — get_object() runs check_object_permissions"
ENFORCED_IN_BODY = "explicit object-permission call in the view body"

# Both idioms count. `check_object_permissions` is the DRF-native one; a direct
# `has_object_permission(...)` call is what the two `@api_view` function views use,
# and it is equally load-bearing.
_BODY_CHECK_IDIOMS = ("check_object_permissions", "has_object_permission(")

# Routes known to have NO enforcement path. Empty, and it must stay that way:
# an entry here is a route where a project-scoped permission class is declared,
# reads as gating in review, and enforces nothing. Adding one is a security
# decision that needs a comment naming the compensating control and an issue.
KNOWN_UNENFORCED: frozenset[str] = frozenset()


def _enforcement_path(path: str, entry: URLPattern, kwarg: str) -> str | None:
    if kwarg == "project_pk":
        return ENFORCED_BY_KWARG
    cls = _view_class(entry)
    if cls is not None and issubclass(cls, ViewSetMixin):
        return ENFORCED_BY_VIEWSET
    source = _view_source(entry)
    if any(idiom in source for idiom in _BODY_CHECK_IDIOMS):
        return ENFORCED_IN_BODY
    return None


def test_every_project_identifying_route_enforces_membership_somewhere() -> None:
    """A route that names a project must enforce access to it by *some* path.

    `_project_pk_from_view` (`permissions.py:320-329`) reads exactly one kwarg
    name. Every project-scoped class then does `if project_pk is not None: …` and
    otherwise `return True`. So `projects/<pk>/…` — as opposed to
    `projects/<project_pk>/…` — gets no `has_permission` enforcement at all, while
    still reading as gated in review. Three issues share this root cause (#2508,
    #2551, #2745), which makes it a pattern rather than an incident.

    Not exploitable today: every such route compensates in the view body or is a
    ViewSet with an object-permission path. This asserts that compensation exists
    — which a refactor can delete in one line, and which `views.py:7674` currently
    asks a reviewer to protect with nothing but a comment.
    """

    unenforced = [
        (path, getattr(_view_class(entry), "__name__", "?"), sorted(declared))
        for path, entry, kwarg, declared in _project_identifying_routes()
        if _enforcement_path(path, entry, kwarg) is None and path not in KNOWN_UNENFORCED
    ]

    assert unenforced == [], (
        "route(s) declare a project-scoped permission class, name a project in the URL, "
        "and enforce nothing:\n"
        + "\n".join(f"    {p}  view={v}  declares={d}" for p, v, d in sorted(unenforced))
        + "\n\nFix by renaming the URL kwarg to `project_pk` (preferred — it makes "
        "has_permission do the work), or by adding an explicit object-permission call "
        "to the view body."
    )


def test_compensating_object_checks_are_pinned() -> None:
    """The routes relying on an in-body check are an inventory, not an accident.

    This is the half that actually fires. Deleting a `check_object_permissions`
    call from any route below leaves the route serving with no enforcement — the
    first test would then catch it, but only if it were reached; this one names
    the exact route so the failure is diagnosable rather than a bare count.

    Routes may leave this set (by moving to a `project_pk` kwarg — an improvement)
    or join it (a new APIView under `projects/<pk>/…`). Either way, updating the
    literal below is the deliberate step.
    """

    actual = {
        path
        for path, entry, kwarg, _ in _project_identifying_routes()
        if _enforcement_path(path, entry, kwarg) == ENFORCED_IN_BODY
    }

    missing = COMPENSATING_ROUTES - actual
    added = actual - COMPENSATING_ROUTES

    assert not missing, (
        "route(s) no longer carry an in-body object-permission check:\n"
        + "\n".join(f"    {p}" for p in sorted(missing))
        + "\n\nIf the route moved to a `project_pk` kwarg, drop it from "
        "COMPENSATING_ROUTES. If the check was refactored away, that route is now "
        "ungated — restore it."
    )
    assert not added, (
        "new route(s) under `projects/<pk>/…` rely on an in-body object-permission "
        "check:\n"
        + "\n".join(f"    {p}" for p in sorted(added))
        + "\n\nPrefer naming the kwarg `project_pk` so has_permission enforces it. "
        "If the in-body check is deliberate, add the route to COMPENSATING_ROUTES."
    )


# Routes under `projects/<pk>/…` whose enforcement lives in the view body rather
# than in `has_permission`. Every entry is a route where the permission class is
# declarative documentation and the in-body call is the actual gate.
COMPENSATING_ROUTES: frozenset[str] = frozenset(
    {
        "api/v1/projects/<pk>/attention/",
        "api/v1/projects/<pk>/board-views/",
        "api/v1/projects/<pk>/board-views/<view_pk>/",
        "api/v1/projects/<pk>/burn/",
        "api/v1/projects/<pk>/flow-metrics/",
        "api/v1/projects/<pk>/forecast/",
        "api/v1/projects/<pk>/milestones/",
        "api/v1/projects/<pk>/my-tasks/",
        "api/v1/projects/<pk>/overview/",
        "api/v1/projects/<pk>/phases/reorder/",
        "api/v1/projects/<pk>/presence/",
        "api/v1/projects/<pk>/sprint-forecast/",
        "api/v1/projects/<pk>/sprint-health/",
        # The five #2745 task-authoring routes. views.py:7674 carries a comment
        # asking that the check not be refactored away; this is that comment as a
        # test.
        "api/v1/projects/<pk>/tasks/<task_id>/indent/",
        "api/v1/projects/<pk>/tasks/<task_id>/outdent/",
        "api/v1/projects/<pk>/tasks/<task_id>/reparent/",
        "api/v1/projects/<pk>/tasks/bulk/",
        "api/v1/projects/<pk>/tasks/classification/",
        "api/v1/projects/<pk>/tasks/reorder/",
        "api/v1/projects/<pk>/velocity/",
        "api/v1/projects/<pk>/workshop/current/",
        "api/v1/projects/<pk>/workshop/end/",
        "api/v1/projects/<pk>/workshop/force-end/",
        "api/v1/projects/<pk>/workshop/start/",
        "api/v1/projects/<str:pk>/forecast-snapshots/",
        # Function views (`@api_view`): the gate is a direct
        # `IsProjectMember().has_object_permission(...)` call, not
        # `check_object_permissions`. Both idioms count.
        "api/v1/projects/<str:pk>/monte-carlo/",
        "api/v1/projects/<str:pk>/monte-carlo/history/",
        "api/v1/projects/<str:pk>/monte-carlo/latest/",
        "api/v1/projects/<str:pk>/monte-carlo/whatif/",
        "api/v1/projects/<str:pk>/schedule/",
        "api/v1/projects/<str:pk>/schedule/derivation/",
        "api/v1/projects/<uuid:pk>/notification-preferences/",
    }
)


# ---------------------------------------------------------------------------
# Invariant 2 — the token-reachable write surface is pinned
# ---------------------------------------------------------------------------


def _token_reachable_write_routes() -> set[str]:
    """Every write route a ``legacy:full`` personal access token can reach.

    ``OwnerScopedApiTokenAuthentication`` is first in
    ``DEFAULT_AUTHENTICATION_CLASSES`` (`settings/base.py:1225-1228`) and admits any
    ``legacy:full`` token — the **default** scope for a newly minted one
    (`apps/projects/models.py:5733-5739`). The scope taxonomy that would let a
    write be withheld is 0.6 work (#2661). So a route is reachable unless it opts
    out of that authenticator or carries ``TokenReadOnlyMethods``.
    """

    routes: set[str] = set()
    for path, entry in _walk():
        if _FORMAT_SUFFIX.search(path):
            continue
        cls = _view_class(entry)
        if cls is None:
            continue
        auth_names = {a.__name__ for a in getattr(cls, "authentication_classes", [])}
        if OwnerScopedApiTokenAuthentication.__name__ not in auth_names:
            continue
        if "TokenReadOnlyMethods" in {p.__name__ for p in getattr(cls, "permission_classes", [])}:
            continue

        actions = getattr(entry.callback, "actions", None)
        if actions:
            methods = {m.upper() for m in actions}
        else:
            methods = {m.upper() for m in getattr(cls, "http_method_names", []) if hasattr(cls, m)}
        if methods & UNSAFE_METHODS:
            routes.add(path)
    return routes


def _read_pinned_surface() -> set[str]:
    lines = TOKEN_WRITE_SURFACE_FILE.read_text().splitlines()
    return {ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")}


def test_token_reachable_write_surface_matches_the_inventory() -> None:
    """The set of token-writable routes is checked in, so growth is deliberate.

    0.5 (#2745, #2749) gets a literal checklist of what to govern. 0.4 gets a
    tripwire that fires if the surface grows between now and then — which, with
    agent-write work landing in the same window, it plausibly will.

    A route entering the set is the interesting direction: it means a new endpoint
    is writable by any personal access token, with no agent-action record (#2749)
    and attribution that resolves to the token's human owner.
    """

    actual = _token_reachable_write_routes()
    pinned = _read_pinned_surface()

    added = sorted(actual - pinned)
    removed = sorted(pinned - actual)

    assert not added, (
        f"{len(added)} route(s) became token-writable and are not in the inventory:\n"
        + "\n".join(f"    {r}" for r in added)
        + f"\n\nIf that is intended, add them to {TOKEN_WRITE_SURFACE_FILE.name} in the "
        "same MR and say so in the description — a token-writable route is one 0.5 has "
        "to govern (#2745, #2749) and writes no agent-action row today."
    )
    assert not removed, (
        f"{len(removed)} route(s) left the token-writable set:\n"
        + "\n".join(f"    {r}" for r in removed)
        + f"\n\nThat is usually good news. Remove them from {TOKEN_WRITE_SURFACE_FILE.name}."
    )


def test_the_inventory_is_not_vacuous() -> None:
    """Guard the guard.

    A bug in `_token_reachable_write_routes` that returned an empty set would make
    the invariant above pass against an empty file and report nothing forever.
    """

    pinned = _read_pinned_surface()
    assert len(pinned) > 100, (
        f"the pinned write surface has only {len(pinned)} entries — the walker is "
        "probably broken rather than the surface having shrunk that far"
    )
    assert "api/v1/projects/<pk>/tasks/bulk/" in pinned, (
        "the endpoint #2749 is specifically about is missing from the inventory — "
        "the walker is not seeing what it should"
    )
