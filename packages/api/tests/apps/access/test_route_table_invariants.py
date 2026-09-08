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
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory
from rest_framework.viewsets import ViewSetMixin

from trueppm_api.apps.access import permissions as permissions_module
from trueppm_api.apps.access.permissions import DEFAULT_PROJECT_URL_KWARG
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


def _declared_project_kwarg(entry: URLPattern) -> str:
    """The kwarg this view says names the project (#2745).

    Mirrors `_project_pk_from_view`, non-string guard included — if this helper and
    the resolver disagreed about what counts as a declaration, the invariant would
    certify an enforcement path the running code does not take.
    """

    declared = getattr(_view_class(entry), "project_url_kwarg", DEFAULT_PROJECT_URL_KWARG)
    return declared if isinstance(declared, str) else DEFAULT_PROJECT_URL_KWARG


def _enforcement_path(path: str, entry: URLPattern, kwarg: str) -> str | None:
    # Resolved against the view's DECLARED kwarg, not the literal `project_pk`
    # (#2745). A route spelling it `<pk>` whose view declares `project_url_kwarg
    # = "pk"` is enforced in `has_permission` exactly like a nested route — that
    # is the whole point of the declaration, and reading only the literal name
    # here would keep classifying those routes as body-compensated forever.
    if kwarg == _declared_project_kwarg(entry):
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
# than in `has_permission`.
#
# This set was 34 routes until #2745. It is now two, and the two are two because
# they are `@api_view` FUNCTION views: there is no class of our own to hang a
# `project_url_kwarg` declaration on, and their gate is a direct
# `IsProjectMember().has_object_permission(...)` call rather than
# `check_object_permissions`. That is a real gate — it is simply not one
# `has_permission` can take over without converting the views first, which is a
# larger change than the resolver fix and is not carried here.
#
# Everything else that used to be in this set now declares the kwarg and is
# enforced in `has_permission`, with the in-body call retained as defense in depth
# and pinned by `test_declared_kwarg_routes_keep_their_in_body_check` below.
#
# `commit/` is the third, and it is here for a different reason than the other two —
# not "the kwarg cannot be declared" but "declaring it would undo a fix" (#3129).
# `ProjectCommitView` is a class and could carry `project_url_kwarg = "pk"`. It must
# not. Doing so resolves the project at `has_permission` time, which answers **403**
# for a real project the caller is not a member of while an unknown id falls through
# `_project_exists` to a **404** — the membership-scoped existence oracle #3129 closed.
# Its gate is instead a membership-filtered queryset plus an in-body
# `check_object_permissions`, which answers 404 uniformly and matches the sibling
# lifecycle endpoint `/archive/`. Renaming the URL kwarg to `project_pk` would also
# work and would 403 uniformly, but that is a different published contract from
# `/archive/`'s, and two sibling lifecycle endpoints disagreeing about whether a
# project's existence is a secret is the thing being fixed.
COMPENSATING_ROUTES: frozenset[str] = frozenset(
    {
        "api/v1/projects/<pk>/commit/",
        "api/v1/projects/<str:pk>/monte-carlo/",
        "api/v1/projects/<str:pk>/schedule/",
    }
)


# The five task-authoring routes #2745 was filed about, plus the #2955 grouping
# primitives that inherited the same shape. `views.py` carries a comment asking that
# their in-body object check not be refactored away; before #2745 that check was the
# ONLY gate. It is now the second of two, and it stays: ADR-0184's additive doctrine
# is that a redundant check is the point, not the smell. Naming them here means
# deleting one is a failing test rather than a silent downgrade to single-gated.
DEFENSE_IN_DEPTH_ROUTES: frozenset[str] = frozenset(
    {
        "api/v1/projects/<pk>/tasks/<task_id>/indent/",
        "api/v1/projects/<pk>/tasks/<task_id>/outdent/",
        "api/v1/projects/<pk>/tasks/<task_id>/reparent/",
        "api/v1/projects/<pk>/tasks/bulk/",
        "api/v1/projects/<pk>/tasks/classification/",
        "api/v1/projects/<pk>/tasks/group/",
        "api/v1/projects/<pk>/tasks/reorder/",
        "api/v1/projects/<pk>/tasks/ungroup/",
    }
)


def test_declared_kwarg_routes_keep_their_in_body_check() -> None:
    """A route that gained `has_permission` enforcement must not lose its body check.

    #2745 moved these routes from "the in-body call is the only gate" to "the
    declared kwarg gates them too". The hazard that creates is a reviewer reading
    the new declaration and deleting the now-redundant in-body call as cleanup —
    which would leave the route single-gated again, this time with nothing naming
    what was lost. `_enforcement_path` reports the FIRST path it finds, so it can
    no longer see these calls; this asserts the source directly.
    """

    by_path = {path: entry for path, entry, _, _ in _project_identifying_routes()}
    missing = sorted(
        path
        for path in DEFENSE_IN_DEPTH_ROUTES
        if path in by_path
        and not any(idiom in _view_source(by_path[path]) for idiom in _BODY_CHECK_IDIOMS)
    )

    assert missing == [], (
        "route(s) lost the in-body object-permission check they are pinned to keep:\n"
        + "\n".join(f"    {p}" for p in missing)
        + "\n\nSince #2745 these are gated twice on purpose (ADR-0184). If removing the "
        "second gate is genuinely intended, drop the route from DEFENSE_IN_DEPTH_ROUTES "
        "in the same commit so the change is on the record."
    )

    unresolved = sorted(DEFENSE_IN_DEPTH_ROUTES - set(by_path))
    assert unresolved == [], (
        "DEFENSE_IN_DEPTH_ROUTES names route(s) that no longer exist:\n"
        + "\n".join(f"    {p}" for p in unresolved)
        + "\n\nA stale entry makes this test vacuous for that route — remove or rename it."
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
    out of that authenticator or carries ``IsNotTokenAuthenticated``.

    **The exclusion used to be ``TokenReadOnlyMethods``, and that was wrong in a way
    worth recording, because it is the failure mode this whole file exists to catch.**
    That guard is contributed at *runtime* by ``McpReadableViewMixin.get_permissions``,
    never listed in a class-level ``permission_classes``, so this static walker never
    excluded a single view on account of it. Every unsafe route on the eight
    MCP-wrapped viewsets (tasks, projects, risks, labels, sprints, programs,
    backlog-items, board-config) was therefore pinned in the inventory as
    token-writable while it in fact 403'd — the inventory was *wrong in the safe
    direction*, and #2877 made it right without producing a diff. A tripwire that
    cannot see the thing it guards reports "no change" for a ~50-route widening.

    ``IsNotTokenAuthenticated`` is declared statically on every view that carries it,
    so this check is sound rather than accidentally sound. If a future guard is again
    applied only through ``get_permissions``, this walker will not see it either — the
    fix then is to name it here, not to trust the silence.
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
        permission_names = {p.__name__ for p in getattr(cls, "permission_classes", [])}
        if "IsNotTokenAuthenticated" in permission_names:
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


# ---------------------------------------------------------------------------
# The archive bypass stays scoped to ProjectViewSet (#3354)
# ---------------------------------------------------------------------------


def test_the_archive_bypass_is_scoped_to_the_project_viewset() -> None:
    """`_ARCHIVE_BYPASS_ACTIONS` must only exempt ProjectViewSet's own lifecycle actions.

    **This test used to be vacuous, and the way it was is the finding (#3414.)** It read
    the action map off ``entry.callback.initkwargs``. DRF's ``ViewSetMixin.as_view``
    assigns the map to ``view.actions`` and passes only the *remaining* kwargs to
    ``view.initkwargs``, so ``initkwargs["actions"]`` does not exist on any route in this
    project: the walk built an empty set and the assertion held over nothing from the day
    it was written. Meanwhile the premise it was defending had already failed — ``destroy``
    is router-minted on every ``ModelViewSet``, and twenty project-scoped viewsets carried
    ``IsProjectNotArchived`` while exposing it, so ``DELETE`` on a task, risk, dependency,
    comment, attachment, label, phase, baseline, membership or assignment answered 204 on
    an archived project.

    The bypass is now decided by ``_bypasses_archive_check``, which requires the view to
    be a ``ProjectViewSet`` instance. This asserts that property directly against a real
    view rather than re-deriving it from the route table, so it cannot be defeated the
    same way twice.
    """
    from trueppm_api.apps.access.permissions import IsProjectNotArchived

    class _NotTheProjectViewSet:
        action = "destroy"

    class _AlsoNotIt:
        action = "restore"

    for view in (_NotTheProjectViewSet(), _AlsoNotIt()):
        assert not IsProjectNotArchived._bypasses_archive_check(view), (  # type: ignore[arg-type]
            f"{type(view).__name__}.{view.action} still bypasses the archived check by "
            "action name. The bypass must be scoped to ProjectViewSet — every other "
            "viewset's destroy/restore is an ordinary write on a frozen plan."
        )

    from trueppm_api.apps.projects.views import ProjectViewSet

    lifecycle = ProjectViewSet()
    for action in sorted(IsProjectNotArchived._ARCHIVE_BYPASS_ACTIONS):
        lifecycle.action = action
        assert IsProjectNotArchived._bypasses_archive_check(lifecycle), (
            f"ProjectViewSet.{action} no longer bypasses the archived check — an Owner "
            "can no longer unarchive, delete or restore an archived project, which is "
            "the catch-22 the bypass exists to prevent."
        )
    lifecycle.action = "partial_update"
    assert not IsProjectNotArchived._bypasses_archive_check(lifecycle), (
        "ProjectViewSet.partial_update is an ordinary write and must not bypass"
    )

    # Guard the guard: the route table must still contain viewsets in the shape the
    # bypass used to leak through, or a later refactor could make this test theoretical.
    exposed: set[str] = set()
    for _path, entry in _walk():
        cls = _view_class(entry)
        if cls is None or not issubclass(cls, ViewSetMixin):
            continue
        if not any(
            p is IsProjectNotArchived for p in (getattr(cls, "permission_classes", []) or [])
        ):
            continue
        actions = set((getattr(entry.callback, "actions", None) or {}).values())
        if (
            actions & IsProjectNotArchived._ARCHIVE_BYPASS_ACTIONS
            and cls.__name__ != "ProjectViewSet"
        ):
            exposed.add(cls.__name__)
    assert len(exposed) >= 10, (
        f"expected many non-ProjectViewSet viewsets to expose a bypass-named action "
        f"(they are why the scoping exists), found {sorted(exposed)} — the walker is "
        "probably reading the wrong attribute again."
    )


# ---------------------------------------------------------------------------
# Invariant 3 — every project-scoped WRITE route enforces archived state (#3414)
# ---------------------------------------------------------------------------
#
# The membership invariant above is scoped to routes whose URL NAMES a project. That is
# the right scope for #2745 and the wrong one for archived enforcement: the routes that
# skip the archived gate are overwhelmingly top-level — `poker/<pk>/vote/`,
# `slip-conflicts/<pk>/acknowledge/`, `project-resources/` — so the suite was green while
# the class was unprotected. !2318 censused 168 `permission_classes` declarations by
# hand, narrowed to one family, and said in as many words that a route-table invariant
# was the durable fix. This is it.
#
# Four things make it more than a second frozen list:
#
# 1. **It resolves what the view REALLY applies.** `get_permissions()` is called on an
#    instantiated view with the action bound, exactly as `test_action_permission_chain`
#    does — because 38 viewsets hand-roll `get_permissions` and a class-level
#    `permission_classes` read reports the wrong answer on all of them (`CalendarViewSet`
#    declares three project classes and applies `IsOrgAdmin`).
#
# 2. **The unit is a (route, action) pair, not a route.** One router route serves several
#    actions with different permission chains — `members/<pk>/` gates `partial_update`
#    and exempts `destroy`, `webhooks/<pk>/` gates the writes and leaves `deliveries`
#    a plain read. Unioning a route's permissions would let one gated action vouch for
#    an ungated sibling, which is the exact masking this file exists to prevent.
#
# 3. **A declared class does not count unless it can FIRE.** This is the whole point.
#    `IsProjectNotArchived` on a route whose kwarg is `pk` with no `project_url_kwarg`
#    resolves nothing and returns True (#2745); on a viewset whose model has no route to
#    a project, `has_object_permission` resolves nothing and returns True; on a top-level
#    `create`, DRF never calls `has_object_permission` at all. All three shapes shipped
#    in this codebase with the class declared, which is why "add the permission class" is
#    a review-proof false fix.
#
# 4. **The denominator is pinned**, so the scan cannot go green by enumerating nothing.

ARCHIVED_BY_KWARG = "IsProjectNotArchived resolves the project in has_permission"
ARCHIVED_BY_OBJECT = "object-level check — has_object_permission resolves the project"
ARCHIVED_IN_BODY = "explicit archived check in the view body"
ARCHIVED_EXEMPT = "declared archived_write_exempt on the view"

#: Idioms that count as an in-body archived check. Deliberately broad — `is_archived`
#: matches a `filter(is_archived=False)` and even a comment — and therefore paired with
#: `ARCHIVED_BODY_ENTRIES` below: a match only counts for an entry that is *also* pinned
#: there by name. A substring scan can show that a mention exists; only the pinned list
#: says a human decided it was a check.
_ARCHIVED_BODY_IDIOMS = (
    "assert_project_not_archived(",
    "_is_project_archived(",
    "IsProjectNotArchived(",
    "is_archived",
)

#: The minimum size of the enumerated write surface. A refactor that renames
#: `get_permissions`, moves the URLconf, or breaks `_walk` would otherwise empty the scan
#: and pass over nothing — the failure mode #2877 recorded on the token inventory, where
#: a walker that could not see its own guard reported "no change" for a ~50-route
#: widening. Raise this when the surface genuinely grows; never lower it to get green.
_MIN_PROJECT_SCOPED_WRITE_ENTRIES = 180

#: Attribute a view sets to opt out. Either a string (the whole view is exempt) or a
#: ``{action: reason}`` mapping when only some of a viewset's actions are — revoking a
#: project API token is exempt while minting one is not, and they share a class.
#:
#: It lives ON THE VIEW rather than in a list here so it travels with the code it
#: excuses — the same reason `data-clip-ok` lives on the element. A list in this file
#: would keep passing after the view it names was rewritten into something the reason no
#: longer describes.
ARCHIVED_EXEMPT_ATTR = "archived_write_exempt"


def _archived_kwargs_in(path: str) -> set[str]:
    """Every URL kwarg name a route captures, in `path()` and `re_path()` form."""
    pattern = re.compile(r"<(?:[a-z]+:)?(\w+)>|\(\?P<(\w+)>")
    return {m.group(1) or m.group(2) for m in pattern.finditer(path)}


def _effective_permission_names(cls: type, action: str | None, method: str) -> set[str]:
    """The permission classes `get_permissions()` really returns for this (route, action).

    Runtime, not AST, and for the same reason `test_action_permission_chain` is: a
    hand-rolled `get_permissions` chain can name an action with `==`, `in`, a dict, or a
    helper, and a static reader that missed one form would silently stop covering that
    viewset instead of failing.
    """
    view = cls()
    view.action = action
    view.format_kwarg = None
    view.kwargs = {}
    view.request = Request(APIRequestFactory().generic(method, "/"))
    return {type(permission).__name__ for permission in view.get_permissions()}


def _unsafe_pairs(entry: URLPattern, cls: type) -> list[tuple[str, str | None]]:
    """`(method, action)` for each unsafe method this route serves.

    Reads `entry.callback.actions`, **not** `initkwargs["actions"]`. DRF's
    `ViewSetMixin.as_view` assigns the action map to `view.actions` and passes only the
    remaining kwargs to `view.initkwargs`, so the latter never contains an `actions`
    key — a reader of `initkwargs` enumerates an empty map for every router route in the
    project and reports no findings forever. That is exactly what
    `test_no_viewset_but_projectviewset_exposes_an_archive_bypass_action` did before
    #3414.
    """
    actions = getattr(entry.callback, "actions", None) or {}
    if actions:
        return [(m.upper(), a) for m, a in actions.items() if m.upper() in UNSAFE_METHODS]
    return [
        (m.upper(), None)
        for m in getattr(cls, "http_method_names", [])
        if m.upper() in UNSAFE_METHODS and hasattr(cls, m)
    ]


def _own_source(cls: type | None) -> str:
    """Source of every class in the MRO that we wrote, plus any `@api_view` body.

    The MRO walk matters: `_PokerBase` holds the `check_object_permissions` call that
    gates all six poker routes, and reading only the leaf class would report six ungated
    write routes that are in fact gated. It is filtered to `trueppm_api` modules because
    DRF's own `APIView` source contains the *definition* of `check_object_permissions`,
    which would make every view in the project match.
    """
    if cls is None:
        return ""
    targets: list[Any] = [
        k
        for k in getattr(cls, "__mro__", [cls])
        if getattr(k, "__module__", "").startswith("trueppm_api")
    ]
    targets += _wrapped_function_views(cls)
    out = []
    for target in targets:
        try:
            out.append(inspect.getsource(target))
        except (OSError, TypeError):
            continue
    return "\n".join(out)


def _object_hop_resolves(cls: type) -> bool:
    """Can `_get_project_id_from_obj` reach a project from this viewset's model?

    `has_object_permission` returns True when it cannot resolve a project id — a
    fail-open — so a detail route on a model with no route to a project is NOT gated by
    a declared `IsProjectNotArchived`, however it reads.

    Two details, both load-bearing:

    - checked with `hasattr` on the model CLASS, because the resolver uses `hasattr`
      too and several models expose `project_id` as a *property* rather than a column
      (`RetroBoardItem.project_id` walks retro → sprint → project, `TaskResource`'s
      walks task → project). A `_meta.get_fields()` check would report those as
      unresolvable and demand exemptions for routes that are correctly gated.
    - a NULLABLE concrete FK does not count. Django installs the descriptor on the class
      either way, so `hasattr` is True while `obj.project_id` is `None` at runtime — and
      `None` is the fail-open. A property cannot be inspected for nullability, so it is
      taken at its word; a concrete field is checked.
    """
    queryset = getattr(cls, "queryset", None)
    if queryset is None:
        return True  # APIView, or a get_queryset-only viewset — nothing to judge.
    model = queryset.model
    if model.__name__ == "Project":
        return True
    for attr in ("project_id", "predecessor_id"):
        if not hasattr(model, attr):
            continue
        try:
            field = model._meta.get_field(attr.removesuffix("_id"))
        except Exception:
            return True
        if not getattr(field, "null", False):
            return True
    return False


def _project_resolving_permission_classes() -> set[str]:
    """Permission classes that resolve a project from EITHER a URL kwarg or an object.

    Wider than `_project_scoped_permission_classes` above, which the membership
    invariant uses: that one keys on `_project_pk_from_view` alone, because #2745 is a
    URL-kwarg defect. Archived enforcement also runs object-level, so a class that only
    resolves through `_get_project_id_from_obj` — `IsTaskScopeManager` is the live
    example, and it is the only thing marking `slip-conflicts/<pk>/acknowledge/` as
    project-scoped — has to count here or that route leaves the denominator entirely.
    """
    found: set[str] = {"IsProjectNotArchived"}
    for name, obj in vars(permissions_module).items():
        if not (inspect.isclass(obj) and hasattr(obj, "has_permission")):
            continue
        try:
            source = inspect.getsource(obj)
        except (OSError, TypeError):
            continue
        if "_project_pk_from_view" in source or "_get_project_id_from_obj" in source:
            found.add(name)
    return found


def _entry_key(path: str, action: str | None, method: str) -> str:
    """Stable name for one (route, action) pair — what the pinned sets are keyed by."""
    return f"{path}::{action or method.lower()}"


def _project_scoped_write_entries() -> list[
    tuple[str, str, URLPattern, str | None, set[str], list[str]]
]:
    """Every (write route, action) pair that touches a single project.

    Discovery is a union of five runtime signals rather than one, because no single one
    covers the surface: `slip-conflicts/<pk>/acknowledge/` names no project and applies
    no project-scoped class (its gate is in the body), while `project-resources/` names
    no project but applies four.

    Returns `(key, path, entry, action, effective_permission_names, why_project_scoped)`.
    """
    scoped = _project_resolving_permission_classes()
    rows = []
    for path, entry in _walk():
        if _FORMAT_SUFFIX.search(path) or path.startswith("admin/"):
            continue
        cls = _view_class(entry)
        if cls is None:
            continue
        inherited: set[str] = set()
        for klass in getattr(cls, "__mro__", []):
            declared = klass.__dict__.get("permission_classes") or []
            inherited |= {p.__name__ for p in declared}
        kwargs = _archived_kwargs_in(path)
        for method, action in _unsafe_pairs(entry, cls):
            key = _entry_key(path, action, method)
            effective = _effective_permission_names(cls, action, method)
            why: list[str] = []
            if _PROJECT_SEGMENT.search(path) or DEFAULT_PROJECT_URL_KWARG in kwargs:
                why.append("url names a project")
            if isinstance(getattr(cls, "project_url_kwarg", None), str):
                why.append("view declares project_url_kwarg")
            if effective & scoped:
                why.append(f"applies {sorted(effective & scoped)}")
            elif inherited & scoped:
                # A viewset whose chain drops the project classes for THIS action still
                # belongs to the surface — `DependencyViewSet.accept` swaps them for a
                # body check, and dropping it from the denominator would excuse exactly
                # the actions most likely to have lost the gate by accident.
                why.append(f"inherits {sorted(inherited & scoped)}")
            if key in ARCHIVED_BODY_ENTRIES:
                # A route pinned here can have no permission class left to discover it
                # by (#3569 dropped `TaskSkillRequirementViewSet`'s declared-but-inert
                # `IsProjectNotArchived` — it could never fire on `create` anyway, and
                # keeping it declared just to be found by this scan is the exact
                # "declared class that cannot fire" anti-pattern this file's own
                # rationale above argues against). Being pinned in
                # `ARCHIVED_BODY_ENTRIES` is itself the human decision that the route is
                # project-scoped, so it has to count as a discovery signal in its own
                # right — otherwise the route silently falls out of the enumerated
                # surface the moment its last permission-class trace is removed.
                why.append("pinned in ARCHIVED_BODY_ENTRIES")
            if why:
                rows.append((key, path, entry, action, effective, why))
    return rows


def _archived_exemption_reason(cls: type, action: str | None) -> str | None:
    """The stated reason this (view, action) is exempt, or None.

    A plain string exempts the whole view. A mapping exempts only the actions it names,
    which is what lets `ProjectApiTokenViewSet` refuse token *minting* on an archived
    project while still allowing token *revocation* — two actions, one class.
    """
    declared = getattr(cls, ARCHIVED_EXEMPT_ATTR, None)
    if isinstance(declared, str):
        return declared
    if isinstance(declared, dict) and action is not None:
        value = declared.get(action)
        return value if isinstance(value, str) else None
    return None


def _archived_enforcement_path(
    key: str, path: str, entry: URLPattern, action: str | None, effective: set[str]
) -> str | None:
    """How this (route, action)'s archived check actually fires — or None if it does not."""
    cls = _view_class(entry)
    assert cls is not None
    reason = _archived_exemption_reason(cls, action)
    if reason is not None and reason.strip():
        return ARCHIVED_EXEMPT

    source = _own_source(cls)
    if "IsProjectNotArchived" in effective:
        if _declared_project_kwarg(entry) in _archived_kwargs_in(path):
            return ARCHIVED_BY_KWARG
        if (
            issubclass(cls, ViewSetMixin)
            and "pk" in _archived_kwargs_in(path)
            and _object_hop_resolves(cls)
        ):
            return ARCHIVED_BY_OBJECT
        if "check_object_permissions(" in source:
            # The view hands DRF an object itself — `_PokerBase._session` resolves the
            # round's Project and checks against that, `ProjectCommitView` against the
            # project it just fetched. Every declared class's `has_object_permission`
            # runs on it, `IsProjectNotArchived` included, so the gate does fire even
            # though neither the kwarg nor the viewset path above can see it.
            return ARCHIVED_BY_OBJECT
    if key in ARCHIVED_BODY_ENTRIES and any(idiom in source for idiom in _ARCHIVED_BODY_IDIOMS):
        return ARCHIVED_IN_BODY
    return None


#: (route, action) pairs whose archived enforcement lives in the view body rather than in
#: a permission class that can fire on its own. Pinned by name so deleting one of those
#: calls is a failing test with a route in the message, not a silent return to fail-open
#: — and so the deliberately loose `is_archived` idiom above cannot certify a route
#: nobody decided about.
#:
#: Every entry is here for one of the structural reasons the permission class cannot
#: cover: the project arrives in the request BODY, the route is an `@api_view` function
#: whose generated class carries no `project_url_kwarg`, or the object handed to
#: `has_object_permission` has no relation the resolver walks.
ARCHIVED_BODY_ENTRIES: frozenset[str] = frozenset(
    {
        "api/v1/^project-resources/$::create",
        "api/v1/^task-resources/$::create",
        "api/v1/^task-skill-requirements/$::create",
        "api/v1/^slip-conflicts/(?P<pk>[^/.]+)/acknowledge/$::acknowledge",
        "api/v1/integrations/projects/<uuid:project_pk>/git-webhook/::post",
        "api/v1/projects/<str:pk>/monte-carlo/::post",
        "api/v1/projects/<str:pk>/schedule/::post",
        "api/v1/projects/<uuid:pk>/sync/::post",
        "api/v1/^acceptance-criteria/$::create",
        # ADR-0120 D2/C2: `accept`/`reject` deliberately swap the project-scoped classes
        # for a body check, because authority over a pending cross-project edge belongs
        # to the DOWNSTREAM project and the generic classes resolve the predecessor's.
        # The archived check follows the same successor project.
        "api/v1/^dependencies/(?P<pk>[^/.]+)/accept/$::accept",
        "api/v1/^dependencies/(?P<pk>[^/.]+)/reject/$::reject",
    }
)


def test_every_project_scoped_write_route_enforces_archived_state() -> None:
    """A write that touches one project must be refusable when that project is archived.

    Archived is a hard read-only contract (#530), and it is *lifecycle state, not
    authority* — which is why it cannot be left to the role classes and why a route that
    omits it does not look wrong in review. The four accepted enforcement paths are the
    four ways it can actually run; anything else is a route where the contract is
    documented and not kept.
    """
    unenforced = [
        (key, getattr(_view_class(entry), "__name__", "?"), why)
        for key, path, entry, action, effective, why in _project_scoped_write_entries()
        if _archived_enforcement_path(key, path, entry, action, effective) is None
    ]

    assert unenforced == [], (
        "project-scoped write route(s) with no archived enforcement on any path:\n"
        + "\n".join(f"    {k}  view={v}  ({'; '.join(w)})" for k, v, w in sorted(unenforced))
        + "\n\nFix by (a) adding IsProjectNotArchived where the route names the project "
        "in a kwarg the view declares, (b) calling assert_project_not_archived(...) in "
        "the body where the project comes from the request body or a relation the "
        "permission class cannot walk — and adding the entry to ARCHIVED_BODY_ENTRIES — "
        'or (c) setting `archived_write_exempt = "<reason>"` (or `{"<action>": '
        '"<reason>"}`) on the view if the write genuinely must survive archiving. '
        "Appending the permission class WITHOUT a resolvable kwarg is the false fix this "
        "test exists to catch (#2745, #3414)."
    )


def test_body_enforced_archived_entries_keep_their_check() -> None:
    """The entries that can only be gated in the body are an inventory, not an accident.

    `_archived_enforcement_path` reports the FIRST path it finds, so an entry that later
    gains a resolvable kwarg legitimately leaves this set — but one that leaves it
    because someone deleted the call is a live fail-open, and the first test would only
    catch it if nothing else on the class happened to match an idiom.
    """
    actual = {
        key
        for key, path, entry, action, effective, _ in _project_scoped_write_entries()
        if _archived_enforcement_path(key, path, entry, action, effective) == ARCHIVED_IN_BODY
    }
    missing = sorted(ARCHIVED_BODY_ENTRIES - actual)
    assert missing == [], (
        "entry/entries no longer carry an in-body archived check:\n"
        + "\n".join(f"    {p}" for p in missing)
        + "\n\nIf the route moved to a permission class that really fires, drop it from "
        "ARCHIVED_BODY_ENTRIES. If the call was refactored away, that route now accepts "
        "writes to archived projects — restore it."
    )


def test_archived_write_exemptions_state_a_reason() -> None:
    """Every opt-out names itself and says why, and the set of them is pinned.

    An exemption is a decision that archived does not apply to a particular write. It is
    allowed — revoking a share link, revoking a leaked API token, removing yourself from
    a project and cancelling an in-flight run all have to survive archiving — but it must
    be a sentence somebody wrote, on the view, and adding one must show up as a diff in
    this file rather than as one more quiet attribute.
    """
    exempt: dict[str, str] = {}
    for key, _path, entry, action, _effective, _why in _project_scoped_write_entries():
        cls = _view_class(entry)
        assert cls is not None
        reason = _archived_exemption_reason(cls, action)
        if reason is not None:
            assert len(reason.strip()) >= 40, (
                f"{cls.__name__}.{action} sets {ARCHIVED_EXEMPT_ATTR} to {reason!r} — it "
                "must be a sentence saying why this write survives archiving, not a flag."
            )
            exempt[key] = reason

    added = sorted(set(exempt) - ARCHIVED_EXEMPT_ENTRIES)
    removed = sorted(ARCHIVED_EXEMPT_ENTRIES - set(exempt))
    assert not added, (
        "new archived-write exemption(s) not recorded in ARCHIVED_EXEMPT_ENTRIES:\n"
        + "\n".join(f"    {p}\n        {exempt[p]}" for p in added)
        + "\n\nAdd them here in the same MR so the opt-out is reviewed rather than "
        "merged as an attribute nobody read."
    )
    assert not removed, (
        "ARCHIVED_EXEMPT_ENTRIES names entry/entries that no longer claim an exemption:\n"
        + "\n".join(f"    {p}" for p in removed)
        + "\n\nA stale entry makes this test vacuous for that route — remove it."
    )


#: The (route, action) pairs that deliberately keep working on an archived project. Each
#: one's reason lives on its view; this set exists so adding one is a reviewable diff.
#:
#: Three of the six are *revocation* — a share link, a project API token, a membership.
#: They share one argument: archiving freezes a plan, it does not stop an already-issued
#: credential or an already-granted seat from working, so closing the only route that
#: takes one away would strand an admin holding a live grant on a frozen project.
ARCHIVED_EXEMPT_ENTRIES: frozenset[str] = frozenset(
    {
        "api/v1/^calendars/$::create",
        "api/v1/^calendars/(?P<pk>[^/.]+)/$::destroy",
        "api/v1/^calendars/(?P<pk>[^/.]+)/$::partial_update",
        "api/v1/^calendars/(?P<pk>[^/.]+)/$::update",
        "api/v1/programs/<program_pk>/api-tokens/::create",
        "api/v1/programs/<program_pk>/api-tokens/<pk>/::destroy",
        "api/v1/^projects/(?P<pk>[^/.]+)/export/$::export",
        "api/v1/^projects/(?P<pk>[^/.]+)/visit/$::visit",
        "api/v1/projects/<project_pk>/api-tokens/<pk>/::destroy",
        "api/v1/projects/<uuid:project_pk>/members/<uuid:pk>/::destroy",
        "api/v1/projects/<project_pk>/share-links/<link_id>/revoke/::post",
        "api/v1/projects/<project_pk>/task-runs/<pk>/cancel/::cancel",
        "api/v1/projects/<uuid:pk>/notification-preferences/::patch",
        "api/v1/workspace/groups/<uuid:group_id>/projects/<uuid:project_id>/::delete",
        "api/v1/workspace/groups/<uuid:group_id>/projects/<uuid:project_id>/::post",
    }
)


def test_the_archived_scan_is_not_vacuous() -> None:
    """Guard the guard.

    Every assertion above is over a set this walker builds. If the walker breaks — a
    URLconf move, a `get_permissions` rename, a `_walk` regression — the set empties and
    all three tests pass while covering nothing. That is not hypothetical: the archive
    bypass test in this file read the action map off `initkwargs`, where DRF never puts
    it, and asserted over an empty set from the day it was written until #3414.
    """
    entries = _project_scoped_write_entries()
    assert len(entries) >= _MIN_PROJECT_SCOPED_WRITE_ENTRIES, (
        f"only {len(entries)} project-scoped write entries enumerated (expected >= "
        f"{_MIN_PROJECT_SCOPED_WRITE_ENTRIES}). The walker has stopped seeing them — fix "
        "the discovery rather than lowering the floor."
    )

    keys = {key for key, *_ in entries}
    # Three entries that must stay in the denominator, one per discovery signal, so a
    # narrowing of any single signal fails loudly instead of shrinking the surface.
    for probe in (
        "api/v1/projects/<pk>/tasks/bulk/::post",  # url names a project
        "api/v1/^task-resources/$::create",  # top-level; found via its permission classes
        "api/v1/^slip-conflicts/(?P<pk>[^/.]+)/acknowledge/$::acknowledge",  # via inheritance
    ):
        assert probe in keys, f"{probe} dropped out of the project-scoped write surface"

    assert keys >= ARCHIVED_BODY_ENTRIES, (
        "ARCHIVED_BODY_ENTRIES names entry/entries outside the enumerated surface: "
        f"{sorted(ARCHIVED_BODY_ENTRIES - keys)}"
    )
    assert keys >= ARCHIVED_EXEMPT_ENTRIES, (
        "ARCHIVED_EXEMPT_ENTRIES names entry/entries outside the enumerated surface: "
        f"{sorted(ARCHIVED_EXEMPT_ENTRIES - keys)}"
    )
