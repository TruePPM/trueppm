"""The role x route refusal matrix — an oracle for the 5-role model (#3441).

``test_route_table_invariants.py`` pins two *binary* properties of the route table:
membership is enforced by **some** path (#2745), and a project-scoped write is
refusable when the project is archived (#3414). Neither asks the question this file
asks, which is the larger dimension: **for each route, which of the five roles gets
in and which is refused?**

Ten open authorization findings share one root cause — a defect class fixed at its
instances (#2861). The suite is dense on what a *permitted* caller can do (1,330
refusal assertions against 2,439 success assertions; VIEWER named 198 times against
MEMBER's 668), so a new endpoint's missing gate is invisible until an audit finds it.
This enumerates the whole surface instead and checks the answer in.

**What is asserted, exactly.** For every (method, route, action) the URLconf serves,
this resolves the permission chain the view would *really* apply — instantiated,
action bound, `get_permissions()` called, exactly as `test_action_permission_chain`
does and for the same reason (38 viewsets hand-roll the chain, so a class-level
`permission_classes` read reports the wrong answer on all of them) — and runs every
returned permission's ``has_permission`` for seven principals: anonymous, an
authenticated non-member, and a Viewer / Member / Scheduler / Admin / Owner of the
same project *and* program. The seven verdicts become a seven-character mask, and
every mask is checked in to ``role_route_matrix.txt``.

**The denominator is the entry gate, and that is a deliberate scope call.**
``has_permission`` runs before the view body on every request, so it is the one layer
whose verdict is a property of the (route, role) pair alone and can therefore be
enumerated without fabricating an instance of every model. ``has_object_permission``
and in-body role checks are **not** covered. Two mutation experiments fix exactly where
that line falls, and both were run rather than reasoned about:

- Removing ``restore`` from ``TaskViewSet``'s destroy-parity branch (#2508's shape)
  changes **no** mask. ``^tasks/<pk>/restore/`` carries no resolvable project kwarg, so
  every branch of that chain is authentication-only at ``has_permission`` and the whole
  difference lives in ``has_object_permission``.
- Deleting the declared-but-inert ``IsProjectMember`` from ``run_monte_carlo``
  (#2551's shape) also changes no mask — correctly. That class cannot fire on that
  route, which is the finding #2551 records; a matrix that moved would be reporting a
  gate that was never there. Its live gate is the hand-rolled in-body
  ``has_object_permission`` call, pinned by ``COMPENSATING_ROUTES`` in
  ``test_route_table_invariants.py``.

So a defect that lives only in a serializer field (#2586), only in a bulk write path
(#2984), or only in a hand-built queryset (#2505) is outside this oracle by
construction. Do not read a green run as a claim about them. What a green run does
claim, over the whole enumerated surface: nobody's entry-gate verdict changed.

**Why a checked-in mask rather than a per-view declaration.** The issue (#3441) asked
for "a declared expectation that lives with the view". For the two invariants where an
opt-out is a *decision* — a project-scoped route reachable anonymously, and a route
whose project kwarg resolves yet admits a non-member — the reason does live on the
view, in ``role_gate_exempt``, exactly like ``archived_write_exempt``. For the matrix
itself a per-view declaration would be ~600 attributes restating what the code already
says, and would drift the moment a shared base class changed. The checked-in mask is
the declaration: a *new* route with no line fails, and a route whose mask *changes*
fails with both masks in the message. Absence is the defect, and it is not the
default-pass.

#3414's archived dimension is deliberately **left as its own invariant** —
``test_route_table_invariants.test_every_project_scoped_write_route_enforces_archived_state``.
Archived is lifecycle state, not authority: it applies identically to all five roles,
so folding it in would add a column that is constant by definition and would put two
unrelated failure modes behind one diff.
"""

from __future__ import annotations

import datetime
import os
import re
import uuid
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.request import Request
from rest_framework.settings import api_settings
from rest_framework.test import APIRequestFactory

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.permissions import DEFAULT_PROJECT_URL_KWARG
from trueppm_api.apps.projects.models import Program, Project

MATRIX_FILE = Path(__file__).parent / "role_route_matrix.txt"

#: Set to regenerate ``role_route_matrix.txt`` from the running URLconf.
#:
#: Be honest about what this is: a rubber stamp, exactly like ``--update-baseline`` on
#: the docs gate. It cannot stop a wrong answer — a regenerate gets today's outcome
#: whatever today's outcome is. What it removes is the *silence*: the regenerated file
#: is a diff, and a mask flipping from ``-----++`` to ``--+++++`` on a settings route
#: is a line a reviewer can see. Hand-editing 600 lines is not a realistic alternative
#: for a legitimate URLconf change, and an unusable regeneration path is how a golden
#: file stops being maintained and starts being deleted.
UPDATE_ENV = "TRUEPPM_UPDATE_ROLE_MATRIX"

#: Principals, in mask order. The five roles hold their role on **both** the fixture
#: project and the fixture program, so one pass covers project- and program-scoped
#: routes without doubling the matrix.
PRINCIPALS = ("anon", "non-member", "viewer", "member", "scheduler", "admin", "owner")
_ROLE_PRINCIPALS = PRINCIPALS[2:]

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

_KWARG = re.compile(r"<(?:[a-z]+:)?(\w+)>|\(\?P<(\w+)>")
_PROJECT_SEGMENT = re.compile(r"projects/(?:<(?:[a-z]+:)?(\w+)>|\(\?P<(\w+)>)")
_PROGRAM_SEGMENT = re.compile(r"programs/(?:<(?:[a-z]+:)?(\w+)>|\(\?P<(\w+)>)")
# DRF's format-suffix routes duplicate every router route and add nothing to the
# surface — same view, same permissions, same verdicts. Both spellings, because the
# router emits the re_path form and `format_suffix_patterns` the path() form.
_FORMAT_SUFFIX = re.compile(r"\\\.\(\?P<format>[^)]*\)/\?\$?$|<drf_format_suffix:\w+>")

#: Attribute a view sets to opt out of one of the two hard invariants below. Either a
#: string (the whole view is exempt) or a ``{action: reason}`` mapping when only some
#: of a viewset's actions are.
#:
#: It lives ON THE VIEW rather than in a list here so it travels with the code it
#: excuses — the same argument ``archived_write_exempt`` is placed by. A list in this
#: file would keep passing after the view it names was rewritten into something the
#: reason no longer describes.
ROLE_EXEMPT_ATTR = "role_gate_exempt"

#: Floors that keep the scan from passing over nothing. The failure mode is not
#: hypothetical: ``test_no_viewset_but_projectviewset_exposes_an_archive_bypass_action``
#: read the action map off ``initkwargs``, where DRF never puts it, and asserted over an
#: empty set from the day it was written until #3414. Raise these when the surface
#: genuinely grows; never lower one to get green.
_MIN_MATRIX_ENTRIES = 550
_MIN_PROJECT_SCOPED_ENTRIES = 260
#: How many routes must still tell one role apart from another, per scope.
_MIN_ROLE_DISCRIMINATING_PROJECT = 60
_MIN_ROLE_DISCRIMINATING_PROGRAM = 20

#: Authenticators that can produce a *human* principal — a person holding a session or
#: a JWT. A view that lists none of these cannot be reached by any of the five roles
#: however they are gated afterwards: DRF's authenticators run before ``has_permission``
#: and leave ``request.user`` anonymous, so the role never enters the decision.
#:
#: **This is the trap the oracle would otherwise fall into.** ``TaskSyncView`` and
#: ``AcceptanceResultIngestView`` accept only ``ProjectApiTokenAuthentication``. Force a
#: real user onto the request and their chains sail through — ``IsTokenForProject`` keys
#: on ``request.auth``, which is ``None`` for a principal the authenticator never
#: produced, so the class that *is* the IDOR gate silently abstains. The oracle would
#: then report both as admitting any authenticated non-member, which is the exact
#: opposite of the truth: no human can call either one at all. An identity refusal comes
#: from the authenticator, and a check keyed on ``request.auth`` cannot see it.
#:
#: The token-reachable surface is pinned separately, by ``token_write_surface.txt`` in
#: this directory. This file is the human 5-role oracle and says nothing about tokens.
_HUMAN_AUTHENTICATORS = frozenset(
    {"JWTAuthentication", "SessionAuthentication", "BasicAuthentication"}
)

#: One entry per discovery shape. If any of these drops out, a single narrowing has
#: silently shrunk the surface and the floor above is too coarse to notice.
_PROBE_ENTRIES = (
    "POST api/v1/projects/<pk>/tasks/bulk/::post",  # <pk>-routed APIView
    "PATCH api/v1/projects/<uuid:project_pk>/members/<uuid:pk>/::partial_update",  # nested viewset
    "POST api/v1/^task-resources/$::create",  # top-level, project resolved from the body
    "GET api/v1/^programs/(?P<pk>[^/.]+)/projects/$::projects",  # program-scoped (#3439)
    "POST api/v1/projects/<pk>/task-sync/::post",  # #3413's route
    "POST api/v1/projects/<str:pk>/monte-carlo/::post",  # #2551's route
    "POST api/v1/^tasks/(?P<pk>[^/.]+)/restore/$::restore",  # #2508's route
    "GET api/v1/^projects/trash/$::trash",  # #2505's route
)


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


def _kwarg_names(path: str) -> list[str]:
    return [m.group(1) or m.group(2) for m in _KWARG.finditer(path)]


def _declared_project_kwarg(cls: type) -> str:
    """The kwarg this view says names the project.

    Mirrors ``_project_pk_from_view``'s non-string guard. If this helper and the
    resolver disagreed about what counts as a declaration, the invariant would certify
    an enforcement path the running code does not take.
    """
    declared = getattr(cls, "project_url_kwarg", DEFAULT_PROJECT_URL_KWARG)
    return declared if isinstance(declared, str) else DEFAULT_PROJECT_URL_KWARG


def _method_action_pairs(entry: URLPattern, cls: type) -> list[tuple[str, str | None]]:
    """``(method, action)`` for every method this route serves.

    Reads ``entry.callback.actions``, **not** ``initkwargs["actions"]``. DRF's
    ``ViewSetMixin.as_view`` assigns the action map to ``view.actions`` and passes only
    the remaining kwargs to ``view.initkwargs``, so the latter never carries an
    ``actions`` key — a reader of ``initkwargs`` enumerates an empty map for every
    router route in the project and reports no findings forever (#3414).

    The unit is a (route, action) pair, not a route: one router route serves several
    actions with different permission chains, and unioning them would let one gated
    action vouch for an ungated sibling.
    """
    actions = getattr(entry.callback, "actions", None) or {}
    if actions:
        return [(m.upper(), a) for m, a in actions.items() if m.upper() in METHODS]
    return [
        (m.upper(), None)
        for m in getattr(cls, "http_method_names", [])
        if m.upper() in METHODS and hasattr(cls, m.lower())
    ]


def _entry_key(method: str, path: str, action: str | None) -> str:
    """Stable name for one (method, route, action) — what the matrix is keyed by."""
    return f"{method} {path}::{action or method.lower()}"


# ---------------------------------------------------------------------------
# Scope classification
# ---------------------------------------------------------------------------


def _project_kwarg_in_path(path: str, cls: type) -> str | None:
    """The path kwarg that ``_project_pk_from_view`` would resolve, if any.

    This is the *resolvable* half of project scope — the routes where the entry gate
    has a project id in hand and any role check can therefore actually run. A route
    spelling the project ``<pk>`` with no ``project_url_kwarg`` declaration is NOT
    here, and that is the point: the permission resolves nothing and returns True,
    which is the shape #2745 / #2508 / #2551 / #3413 all share.
    """
    declared = _declared_project_kwarg(cls)
    return declared if declared in _kwarg_names(path) else None


def _names_a_project_or_program(path: str) -> bool:
    """The URL *reads* as project- or program-scoped, however it is enforced."""
    kwargs = set(_kwarg_names(path))
    return bool(
        _PROJECT_SEGMENT.search(path)
        or _PROGRAM_SEGMENT.search(path)
        or kwargs & {"project_pk", "project_id", "program_pk", "program_id"}
    )


def _human_reachable(view: Any) -> bool:
    """Can a person holding a session or JWT reach this view, for THIS request?

    Resolved through ``get_authenticators()`` on a request-bound view, not off the
    ``authentication_classes`` attribute, for the same reason the permission side calls
    ``get_permissions()`` rather than reading ``permission_classes``: the runtime method
    is overridden in this codebase and the attribute would report the wrong answer.
    ``McpReadableViewMixin.get_authenticators`` prepends a token authenticator on 19
    views, and ``WorkspaceLogoView.get_authenticators`` returns ``[]`` **for GET only** —
    a per-method answer a per-class attribute read cannot express at all.

    Falls back to the attribute, then to the project-wide default, when the method
    raises: a view that cannot be asked is judged by what DRF would apply, never
    silently treated as unreachable (which would read as a clean ``-------``).
    """
    try:
        return bool({type(a).__name__ for a in view.get_authenticators()} & _HUMAN_AUTHENTICATORS)
    except Exception:  # an un-askable view must not read as locked down
        declared = getattr(type(view), "authentication_classes", None)
        if declared is None:
            declared = api_settings.DEFAULT_AUTHENTICATION_CLASSES
        return bool({a.__name__ for a in declared} & _HUMAN_AUTHENTICATORS)


def _exemption_reason(cls: type, action: str | None) -> str | None:
    """The stated reason this (view, action) is exempt from a hard invariant, or None.

    A plain string exempts the whole view; a mapping exempts only the actions it names,
    which is what lets one class hold two different answers for two of its actions.
    """
    declared = getattr(cls, ROLE_EXEMPT_ATTR, None)
    if isinstance(declared, str):
        return declared
    if isinstance(declared, dict) and action is not None:
        value = declared.get(action)
        return value if isinstance(value, str) else None
    return None


# ---------------------------------------------------------------------------
# Building the matrix
# ---------------------------------------------------------------------------


class _Row:
    """One enumerated (method, route, action) and its seven verdicts."""

    __slots__ = ("action", "cls", "key", "mask", "method", "path")

    def __init__(
        self, key: str, mask: str, path: str, method: str, action: str | None, cls: type
    ) -> None:
        self.key = key
        self.mask = mask
        self.path = path
        self.method = method
        self.action = action
        self.cls = cls

    @property
    def is_write(self) -> bool:
        return self.method in UNSAFE_METHODS

    def allows(self, principal: str) -> bool:
        return self.mask[PRINCIPALS.index(principal)] == "+"


#: Name and username prefix the fixture rows carry, so the sweep can find them without
#: touching anything else in a reused database.
_FIXTURE_NAME = "role-matrix-fixture"
_FIXTURE_USER_PREFIX = "rolematrix-"


def _sweep_fixture_rows(user_model: Any) -> None:
    """Remove this module's committed fixture rows, in FK order.

    ``ProjectMembership.project`` and ``ProgramMembership.program`` are ``PROTECT``, so
    the memberships have to go before their parents or the delete raises rather than
    cleaning up. Run at setup as well as teardown: see the fixture docstring.
    """
    projects = Project.objects.filter(name=_FIXTURE_NAME)
    programs = Program.objects.filter(name=_FIXTURE_NAME)
    ProjectMembership.objects.filter(project__in=projects).delete()
    ProgramMembership.objects.filter(program__in=programs).delete()
    programs.delete()
    projects.delete()
    user_model.objects.filter(username__startswith=_FIXTURE_USER_PREFIX).delete()


@pytest.fixture(scope="module")
def _principals(django_db_setup: Any, django_db_blocker: Any) -> Any:
    """Seven principals against one project and one program.

    Module-scoped and built once: the matrix is ~600 entries x 7 principals, and
    rebuilding the fixture per test would run the whole enumeration four times.

    Module scope means these rows are **committed**, outside the per-test transaction,
    so they are torn down by hand below. It also means an interrupted run leaves them
    behind — and ``api:test`` runs with ``--reuse-db``, so the next session would find
    them and die on the username unique constraint. The sweep at the top makes the
    fixture idempotent rather than leaving that as a once-in-a-while red nobody can
    reproduce.
    """
    with django_db_blocker.unblock():
        user_model = get_user_model()
        _sweep_fixture_rows(user_model)
        project = Project.objects.create(name=_FIXTURE_NAME, start_date=datetime.date(2026, 1, 1))
        program = Program.objects.create(name=_FIXTURE_NAME)
        users: dict[str, Any] = {"anon": AnonymousUser()}
        for principal, role in zip(
            _ROLE_PRINCIPALS,
            (Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER),
            strict=True,
        ):
            user = user_model.objects.create_user(
                username=f"{_FIXTURE_USER_PREFIX}{principal}", password=uuid.uuid4().hex
            )
            ProjectMembership.objects.create(project=project, user=user, role=role)
            ProgramMembership.objects.create(program=program, user=user, role=role)
            users[principal] = user
        users["non-member"] = user_model.objects.create_user(
            username=f"{_FIXTURE_USER_PREFIX}nonmember", password=uuid.uuid4().hex
        )
        yield {"users": users, "project": project, "program": program}
        # Module-scoped fixtures escape the per-test transaction, so the rows have to
        # be removed by hand or they leak into every later test in the session.
        _sweep_fixture_rows(user_model)


def _url_kwargs(path: str, cls: type, project: Project, program: Program) -> dict[str, Any]:
    """Fabricate the URL kwargs this route would carry for the fixture project/program.

    Every project-identifying kwarg gets the fixture project's real id, so a permission
    class that resolves one finds a live project with real memberships. Every other
    kwarg gets a random UUID: it must be *present* (a missing kwarg would make a
    resolver return None and fail open for reasons that have nothing to do with role)
    and it must not accidentally name the fixture project.
    """
    project_seg = _PROJECT_SEGMENT.search(path)
    program_seg = _PROGRAM_SEGMENT.search(path)
    project_names = {"project_pk", "project_id", _declared_project_kwarg(cls)}
    if project_seg:
        project_names.add(project_seg.group(1) or project_seg.group(2))
    program_names = {"program_pk", "program_id"}
    if program_seg:
        program_names.add(program_seg.group(1) or program_seg.group(2))

    kwargs: dict[str, Any] = {}
    for name in _kwarg_names(path):
        if name in project_names:
            kwargs[name] = str(project.pk)
        elif name in program_names:
            kwargs[name] = str(program.pk)
        else:
            kwargs[name] = str(uuid.uuid4())
    return kwargs


def _bind(cls: type, action: str | None, method: str, kwargs: dict[str, Any], user: Any) -> Any:
    """A request-bound view instance carrying ``user`` as the already-authenticated
    principal.

    ``request.auth`` is set explicitly, and that line is load-bearing rather than
    tidiness. DRF's ``Request.auth`` is lazy: the first read calls ``_authenticate()``,
    which — on a request built with no authenticators, as this one is — falls through to
    ``_not_authenticated()``, whose ``self.user = UNAUTHENTICATED_USER()`` **overwrites
    the principal we just installed**. Every permission after that point in the same
    chain would then be judged against an anonymous user, and the resulting false ``-``
    is invisible: both hard invariants below only fire on ``+``, so a row would quietly
    read as more locked down than the route is. Assigning ``auth`` up front makes
    ``hasattr(self, "_auth")`` true, so the lazy read never runs.

    This was not hypothetical. ``IsNotTokenAuthenticated`` reads ``request.auth``, and
    without this line **ten** rows — the personal, project and program API-token
    management routes — came out ``-------`` when they are in fact member-readable and
    Admin-writable. The oracle was reporting the most locked-down mask in the file for
    six routes a Viewer can read. ``IsNotTokenAuthenticated``'s own docstring is about
    exactly this trap ("an identity refusal is raised by the *authenticator*, so on that
    path ``request.auth`` is still ``None``"), which is a fair warning that an oracle
    fabricating requests has to model the authenticator or it will measure itself.
    """
    django_request = APIRequestFactory().generic(method, "/")
    django_request.user = user
    request = Request(django_request)
    request.user = user
    request.auth = None
    request._authenticator = None
    view = cls()
    view.action = action
    view.args = ()
    view.kwargs = dict(kwargs)
    view.format_kwarg = None
    view.request = request
    return view


def _verdict(cls: type, action: str | None, method: str, kwargs: dict[str, Any], user: Any) -> str:
    """Run the chain the view would really apply and report one character.

    ``+`` permitted, ``-`` refused, ``!`` the chain raised. ``!`` is its own character
    on purpose: an exception is neither a permit nor a refusal, and collapsing it into
    either would let a broken permission class read as a clean verdict — the "non-zero
    total with every verdict bucket at zero means the tool died" failure, one route at
    a time.

    Reachability is decided here rather than per route, because it is a per-*method*
    property: ``WorkspaceLogoView`` authenticates its writes and not its GET. A view no
    human authenticator can reach sees an anonymous request from every principal — the
    role never enters the decision, so feeding it a real user would let a
    ``request.auth``-keyed class abstain and read as a permit.
    """
    view = _bind(cls, action, method, kwargs, user)
    if not _human_reachable(view):
        view = _bind(cls, action, method, kwargs, AnonymousUser())
    request = view.request
    try:
        permissions = view.get_permissions()
        return "+" if all(p.has_permission(request, view) for p in permissions) else "-"
    except Exception:  # a raising chain is a finding, not a crash
        return "!"


def _build_matrix(ctx: dict[str, Any]) -> tuple[list[_Row], list[str]]:
    """Enumerate the surface. Returns ``(rows, conflicts)``.

    ``conflicts`` names any key two URLconf entries register with *different* masks —
    the API root is registered five times and several ``@action``s serve two methods,
    so a key can legitimately repeat, but two registrations of the same key that
    disagree about who gets in would make the matrix order-dependent.
    """
    users = ctx["users"]
    seen: dict[str, _Row] = {}
    conflicts: list[str] = []

    for path, entry in _walk():
        if not path.startswith("api/v1/") or _FORMAT_SUFFIX.search(path):
            continue
        cls = _view_class(entry)
        if cls is None:
            continue
        kwargs = _url_kwargs(path, cls, ctx["project"], ctx["program"])
        for method, action in _method_action_pairs(entry, cls):
            key = _entry_key(method, path, action)
            mask = "".join(_verdict(cls, action, method, kwargs, users[p]) for p in PRINCIPALS)
            existing = seen.get(key)
            if existing is None:
                seen[key] = _Row(key, mask, path, method, action, cls)
            elif existing.mask != mask:
                conflicts.append(f"{key}: {existing.mask} vs {mask}")
    return sorted(seen.values(), key=lambda r: r.key), conflicts


@pytest.fixture(scope="module")
def matrix(_principals: dict[str, Any], django_db_blocker: Any) -> list[_Row]:
    with django_db_blocker.unblock():
        rows, conflicts = _build_matrix(_principals)
    assert not conflicts, (
        "the same (method, route, action) is registered twice with different verdicts:\n"
        + "\n".join(f"    {c}" for c in conflicts)
        + "\n\nThe matrix would then depend on URLconf order. Resolve the duplicate "
        "registration rather than picking a winner here."
    )
    return rows


# ---------------------------------------------------------------------------
# The golden file
# ---------------------------------------------------------------------------

_HEADER = f"""\
# Role x route refusal matrix (#3441) — the ENTRY gate (`has_permission`) only.
#
# Generated by tests/apps/access/test_role_route_matrix.py. Regenerate with
#     {UPDATE_ENV}=1 pytest tests/apps/access/test_role_route_matrix.py
# and read the diff — that diff is the entire point of the file.
#
# One line per (method, route, action). The mask is seven verdicts in this order:
#
#     anon  non-member  Viewer  Member  Scheduler  Admin  Owner
#
# `+` the chain admits this principal, `-` it refuses, `!` it raised.
#
# A `-` has THREE causes, and `-------` does not mean "maximally safe":
#   1. a permission class refused;
#   2. the AUTHENTICATOR refused — a view whose get_authenticators() yields no human
#      authenticator (the project-API-token ingest endpoints) sees an anonymous
#      request from all seven. The token surface is pinned separately, in
#      token_write_surface.txt;
#   3. the FIXTURE could not build the scope — a route gated on something other than
#      a project or program (a team, a workspace role, a superuser) gets a random
#      UUID for that kwarg, so its gate is refused rather than exercised. Change
#      detection still holds for those rows; discovery does not.
#
# Read `-----++` with the scope in mind too. On a project-scoped route it means
# Admin+ on THAT project. On an install-global route gated by IsOrgAdmin it means
# Admin on ANY live project — and nothing gates project creation (#3569), so that
# mask is reachable by any authenticated account in one request.
#
# The five roles hold that role on the fixture project AND the fixture program.
# A `+` here means only that the request gets past `has_permission`; object-level
# and in-body checks are not modeled (see the module docstring). A `+` in the
# non-member column on a route that names a project is therefore not automatically
# a hole — but it IS a route whose whole defense is downstream, which is the shape
# every one of #2508 / #2551 / #3413 / #3439 took.
"""


def _render(rows: list[_Row]) -> str:
    return _HEADER + "".join(f"{r.mask}  {r.key}\n" for r in rows)


def _read_pinned() -> dict[str, str]:
    pinned: dict[str, str] = {}
    for line in MATRIX_FILE.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        mask, _, key = stripped.partition("  ")
        pinned[key.strip()] = mask
    return pinned


def test_the_role_route_matrix_matches_the_checked_in_oracle(matrix: list[_Row]) -> None:
    """Every route's per-role verdict is checked in; a change is a reviewable diff.

    Three separate diagnostics because the three mean different things:

    - **changed** is the one that matters most. A mask flipping from ``-----++`` to
      ``--+++++`` is a role gate that stopped firing — the #2993 / #2984 shape, where
      the endpoint still works for the author testing with an Admin account.
    - **added** is a new route nobody has declared a role expectation for. It fails,
      because absence is the defect and cannot be the default-pass.
    - **removed** is usually a deleted endpoint, and is asserted so a stale line
      cannot sit in the file making the oracle vacuous for a route that no longer
      exists.
    """
    if os.environ.get(UPDATE_ENV):
        MATRIX_FILE.write_text(_render(matrix))
        pytest.fail(
            f"{MATRIX_FILE.name} regenerated from the running URLconf. Review the diff "
            "and re-run without the env var — a regeneration is a rubber stamp and has "
            "to be looked at to mean anything."
        )

    actual = {row.key: row.mask for row in matrix}
    pinned = _read_pinned()

    added = sorted(set(actual) - set(pinned))
    removed = sorted(set(pinned) - set(actual))
    changed = sorted(k for k in set(actual) & set(pinned) if actual[k] != pinned[k])

    legend = " / ".join(PRINCIPALS)
    assert not changed, (
        f"{len(changed)} route(s) changed who they let past the entry gate ({legend}):\n"
        + "\n".join(f"    {pinned[k]} -> {actual[k]}  {k}" for k in changed)
        + "\n\nA `-` becoming `+` is a gate that stopped firing. If the change is "
        f"intended, regenerate with {UPDATE_ENV}=1 and say in the MR which column moved "
        "and why."
    )
    assert not added, (
        f"{len(added)} route(s) have no declared role expectation ({legend}):\n"
        + "\n".join(f"    {actual[k]}  {k}" for k in added)
        + f"\n\nAdd them by regenerating with {UPDATE_ENV}=1, then READ the mask you "
        "just checked in: a `+` in the non-member column on a project-scoped route "
        "means nothing in `has_permission` refuses a stranger."
    )
    assert not removed, (
        f"{len(removed)} pinned route(s) no longer exist:\n"
        + "\n".join(f"    {pinned[k]}  {k}" for k in removed)
        + f"\n\nA stale line makes the oracle vacuous for that route — regenerate with "
        f"{UPDATE_ENV}=1."
    )


def test_no_permission_chain_raises(matrix: list[_Row]) -> None:
    """A chain that raises is a finding, not a verdict.

    ``has_permission`` runs before anything in the view body, so an exception here is a
    500 on a request that has not been authorized yet — and inside this oracle it would
    otherwise be silently absorbed into whichever character the ``except`` chose.
    """
    raising = [r for r in matrix if "!" in r.mask]
    assert raising == [], "permission chain(s) raised while resolving a verdict:\n" + "\n".join(
        f"    {r.mask}  {r.key}  view={r.cls.__name__}" for r in raising
    )


# ---------------------------------------------------------------------------
# Hard invariant 1 — nothing project-scoped is reachable anonymously
# ---------------------------------------------------------------------------


def test_no_anonymous_access_to_a_project_or_program_scoped_route(matrix: list[_Row]) -> None:
    """A route whose URL names a project or program must refuse an anonymous caller.

    This is the one column with no legitimate ambiguity: object-level checks cannot
    rescue an anonymous request, because every project-scoped object check resolves a
    membership and an anonymous user has none. So unlike the non-member column, a `+`
    here is a finding on its face unless the view says otherwise in a sentence.
    """
    reachable = [
        r
        for r in matrix
        if r.allows("anon")
        and _names_a_project_or_program(r.path)
        and not (_exemption_reason(r.cls, r.action) or "").strip()
    ]
    assert reachable == [], (
        "project/program-scoped route(s) reachable without authentication:\n"
        + "\n".join(f"    {r.key}  view={r.cls.__name__}" for r in reachable)
        + f"\n\nAdd an authentication permission, or set `{ROLE_EXEMPT_ATTR} = "
        '"<why>"` on the view naming the control that replaces it.'
    )


# ---------------------------------------------------------------------------
# Hard invariant 2 — a resolvable project kwarg must actually refuse a stranger
# ---------------------------------------------------------------------------


def test_routes_whose_project_kwarg_resolves_refuse_a_non_member(matrix: list[_Row]) -> None:
    """If the entry gate *can* see the project, it must use it.

    Scoped to routes where ``_project_pk_from_view`` would resolve — the URL carries
    the kwarg the view declares. On those the permission classes have a live project id
    in hand, so "the check could not run" is not available as an explanation: either a
    membership gate fired or none was applied.

    This is deliberately NOT asserted over routes that spell the project ``<pk>``
    without declaring ``project_url_kwarg``. There the resolver genuinely returns None
    and every project-scoped class falls through to ``return True`` — the #2745 shape.
    Asserting over those would demand ~90 exemptions, which is how a gate becomes
    ceremony; they are pinned by their mask in the matrix instead, where the `+` in the
    non-member column is visible on the line.
    """
    leaky = [
        r
        for r in matrix
        if r.allows("non-member")
        and _project_kwarg_in_path(r.path, r.cls) is not None
        and not (_exemption_reason(r.cls, r.action) or "").strip()
    ]
    assert leaky == [], (
        "route(s) resolve a project at the entry gate and still admit a non-member:\n"
        + "\n".join(
            f"    {r.key}  view={r.cls.__name__}  kwarg={_project_kwarg_in_path(r.path, r.cls)}"
            for r in leaky
        )
        + "\n\nAdd a project-scoped permission class, or set "
        f'`{ROLE_EXEMPT_ATTR} = "<why>"` (or `{{"<action>": "<why>"}}`) on the view '
        "naming the object-level or in-body check that enforces membership instead."
    )


def test_role_gate_exemptions_state_a_reason_and_are_pinned(matrix: list[_Row]) -> None:
    """Every opt-out names itself and says why, and the set of them is a diff.

    An exemption is a decision that the entry gate is deliberately not the enforcement
    point for this route. That is often correct — ``TaskLabelView`` gates on the *task*,
    not the project, and cannot do so before ``get_object`` runs — but it must be a
    sentence somebody wrote, on the view, and adding one must show up here rather than
    as one more quiet attribute.
    """
    claimed: dict[str, str] = {}
    for row in matrix:
        reason = _exemption_reason(row.cls, row.action)
        if reason is None:
            continue
        assert len(reason.strip()) >= 40, (
            f"{row.cls.__name__}.{row.action} sets {ROLE_EXEMPT_ATTR} to {reason!r} — it "
            "must be a sentence naming the control that enforces membership instead, "
            "not a flag."
        )
        claimed[row.key] = reason.strip()

    added = sorted(set(claimed) - ROLE_GATE_EXEMPT_ENTRIES)
    removed = sorted(ROLE_GATE_EXEMPT_ENTRIES - set(claimed))
    assert not added, (
        "new role-gate exemption(s) not recorded in ROLE_GATE_EXEMPT_ENTRIES:\n"
        + "\n".join(f"    {k}\n        {claimed[k]}" for k in added)
        + "\n\nAdd them here in the same MR so the opt-out is reviewed rather than "
        "merged as an attribute nobody read."
    )
    assert not removed, (
        "ROLE_GATE_EXEMPT_ENTRIES names entry/entries that no longer claim an exemption:\n"
        + "\n".join(f"    {k}" for k in removed)
        + "\n\nA stale entry makes this test vacuous for that route — remove it."
    )


#: The (method, route, action) pairs that deliberately do not enforce membership at the
#: entry gate. Each one's reason lives on its view; this set exists so adding one is a
#: reviewable diff rather than an attribute.
ROLE_GATE_EXEMPT_ENTRIES: frozenset[str] = frozenset(
    {
        "POST api/v1/integrations/projects/<uuid:project_pk>/git-webhook/::post",
        "DELETE api/v1/projects/<project_pk>/tasks/<task_pk>/field-values/<field_id>/::delete",
        "PUT api/v1/projects/<project_pk>/tasks/<task_pk>/field-values/<field_id>/::put",
        "DELETE api/v1/projects/<project_pk>/tasks/<task_pk>/labels/::delete",
        "POST api/v1/projects/<project_pk>/tasks/<task_pk>/labels/::post",
        "DELETE api/v1/projects/<project_pk>/tasks/<task_pk>/labels/<label_id>/::delete",
        "POST api/v1/projects/<project_pk>/tasks/<task_pk>/labels/<label_id>/::post",
    }
)


# ---------------------------------------------------------------------------
# Hard invariant 3 — the role bands are ordered
# ---------------------------------------------------------------------------

#: Entries whose allow-set across the five roles is deliberately NOT upward-closed.
#:
#: All four are the task-authoring endpoints, and they share one cause: ADR-0773's
#: authoring predicate makes SCHEDULER (Resource Manager) read-only on task *content*
#: while MEMBER may edit their own rows. So Member gets in and Scheduler does not, which
#: is a correctly-shaped hole in the ordering rather than a mistake — a Resource Manager
#: assigns people to work, they do not restructure the plan.
NON_MONOTONIC_ENTRIES: frozenset[str] = frozenset(
    {
        "POST api/v1/projects/<pk>/tasks/bulk/::post",
        "PATCH api/v1/projects/<pk>/tasks/classification/::patch",
        "POST api/v1/projects/<pk>/tasks/group/::post",
        "POST api/v1/projects/<pk>/tasks/ungroup/::post",
    }
)


def test_the_role_bands_are_upward_closed(matrix: list[_Row]) -> None:
    """If a role gets in, every role above it must too — unless pinned as an exception.

    ADR-0072 orders the five roles by privilege. A route that admits Member and refuses
    Scheduler is either encoding a facet rule (the four pinned above) or has an
    inverted comparison, and an inverted comparison is invisible to any test written
    one role at a time — which is how the suite came to name MEMBER 668 times and
    VIEWER 198.
    """
    inverted = []
    for row in matrix:
        band = row.mask[2:]
        if band != "".join(sorted(band, reverse=True)) and row.key not in NON_MONOTONIC_ENTRIES:
            inverted.append(row)
    assert inverted == [], (
        "route(s) admit a lower role while refusing a higher one "
        f"({' / '.join(_ROLE_PRINCIPALS)}):\n"
        + "\n".join(f"    {r.mask[2:]}  {r.key}  view={r.cls.__name__}" for r in inverted)
        + "\n\nIf that inversion is a deliberate facet rule, pin it in "
        "NON_MONOTONIC_ENTRIES with the reason. Otherwise a role comparison is inverted."
    )

    stale = sorted(NON_MONOTONIC_ENTRIES - {r.key for r in matrix})
    assert stale == [], (
        "NON_MONOTONIC_ENTRIES names entry/entries outside the enumerated surface:\n"
        + "\n".join(f"    {k}" for k in stale)
        + "\n\nA stale entry makes this test vacuous for that route — remove it."
    )


# ---------------------------------------------------------------------------
# Guard the guard
# ---------------------------------------------------------------------------


def test_the_matrix_is_not_vacuous(matrix: list[_Row]) -> None:
    """Every assertion above is over a set this walker builds.

    If the walker breaks — a URLconf move, a ``get_permissions`` rename, a ``_walk``
    regression — the set empties and every test above passes while covering nothing.
    Three independent floors, because a single count is exactly what a partially-broken
    walker satisfies: the total, the project-scoped share of it, and named probes for
    each discovery shape.
    """
    assert len(matrix) >= _MIN_MATRIX_ENTRIES, (
        f"only {len(matrix)} (method, route, action) entries enumerated (expected >= "
        f"{_MIN_MATRIX_ENTRIES}). The walker has stopped seeing them — fix the discovery "
        "rather than lowering the floor."
    )

    scoped = [r for r in matrix if _names_a_project_or_program(r.path)]
    assert len(scoped) >= _MIN_PROJECT_SCOPED_ENTRIES, (
        f"only {len(scoped)} project/program-scoped entries (expected >= "
        f"{_MIN_PROJECT_SCOPED_ENTRIES}) — the scope classifier has narrowed."
    )

    keys = {r.key for r in matrix}
    missing_probes = [p for p in _PROBE_ENTRIES if p not in keys]
    assert missing_probes == [], (
        "probe route(s) dropped out of the enumerated surface:\n"
        + "\n".join(f"    {p}" for p in missing_probes)
        + "\n\nEach probe covers one discovery shape. Losing one means a single "
        "narrowing has shrunk the surface in a way the count floors are too coarse to see."
    )


def test_every_verdict_bucket_is_populated(matrix: list[_Row]) -> None:
    """A non-zero total with an empty verdict bucket means the tool died.

    The dangerous failure is not an empty matrix — the floors above catch that — but a
    *full* matrix whose verdicts are uniform: a fixture that never created the
    memberships, a request the permission classes cannot read a user off, a
    ``get_permissions`` that returns ``[]`` for everything. All three produce ~600
    confident rows and an oracle that has measured nothing. Every principal must be
    both admitted somewhere and refused somewhere.
    """
    for principal in PRINCIPALS:
        allowed = sum(1 for r in matrix if r.allows(principal))
        assert 0 < allowed < len(matrix), (
            f"the {principal!r} column is uniform ({allowed}/{len(matrix)} permitted). "
            "A column that never varies is a broken fixture or a broken chain, not a "
            "finding about the API."
        )

    # The specific uniformity that would gut this oracle: the five role columns all
    # agreeing on every row means the matrix has no role dimension left at all.
    #
    # Counted SEPARATELY for project- and program-scoped routes, because one count over
    # the union is satisfied by either half alone. Dropping the ProjectMembership rows
    # from the fixture leaves the ProgramMembership rows discriminating 25 routes — a
    # single total would still clear any threshold worth setting, and the oracle would
    # go on reporting ~600 confident rows in which no project role means anything.
    project_scoped = sum(
        1
        for r in matrix
        if len(set(r.mask[2:])) > 1
        and (
            _PROJECT_SEGMENT.search(r.path)
            or {"project_pk", "project_id"} & set(_kwarg_names(r.path))
        )
    )
    program_scoped = sum(
        1
        for r in matrix
        if len(set(r.mask[2:])) > 1
        and (
            _PROGRAM_SEGMENT.search(r.path)
            or {"program_pk", "program_id"} & set(_kwarg_names(r.path))
        )
    )
    assert project_scoped >= _MIN_ROLE_DISCRIMINATING_PROJECT, (
        f"only {project_scoped} project-scoped route(s) distinguish one role from "
        "another. The ProjectMembership fixture rows are probably not being seen — the "
        "matrix would then be an authentication check wearing a role check's name."
    )
    assert program_scoped >= _MIN_ROLE_DISCRIMINATING_PROGRAM, (
        f"only {program_scoped} program-scoped route(s) distinguish one role from "
        "another. The ProgramMembership fixture rows are probably not being seen."
    )
