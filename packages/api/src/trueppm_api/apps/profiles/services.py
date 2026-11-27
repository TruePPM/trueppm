"""Landing resolution — the role-based app front door (ADR-0129).

``resolve_landing(user)`` is a pure read that decides where a user lands on
login / on hitting ``/``. It is exposed as a server fact on ``/auth/me/`` so that
every client (web, mobile, MCP) resolves the *same* front door without
re-implementing the policy (API-first, CLAUDE.md).

The policy, in order:

1. An explicit ``default_landing`` preference wins (the escape hatch) — honored
   *when reachable*; an unreachable preference (e.g. ``project_overview`` after
   losing access to every project) falls through rather than producing a dead
   route.
2. The published interactive-demo visitor lands on the demo's teaching project's
   Schedule (#4151, ADR-1197) — only while the deployment is actually a read-only
   demo, only for the one published account, and only when that project still
   exists and is readable; otherwise this step is skipped entirely.
3. A user with no project/program membership lands on My Work (its onboarding
   empty state) — never pushed into project creation.
4. Otherwise the role policy: PMO/Exec (portfolio-entitled, Enterprise) →
   Portfolio; PM-type (``max_project_role >= SCHEDULER``) → most-recent project
   Overview; contributor (MEMBER/VIEWER) → My Work.

The function fails *open*: any unexpected error resolves to My Work so the front
door can never 500.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from django.conf import settings
from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import Max, QuerySet
from django.utils import timezone

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.constants import (
    ALWAYS_ON_VIEW_KEYS,
    HIDEABLE_VIEW_KEYS,
    LENS_VIEW_SEEDS,
    METHODOLOGY_HIDDEN_VIEWS,
    METHODOLOGY_NEVER_HIDES,
    PLAN_LAYOUT_KEYS,
    RESOLVED_VIEW_ORDER,
)
from trueppm_api.apps.profiles.models import (
    DateFormat,
    DefaultLanding,
    HomeOverride,
    ProjectViewState,
    ProjectVisit,
    RoleContext,
    UserProfile,
)
from trueppm_api.core.extension_providers import (
    guard_single_provider,
    invoke_extension_provider,
)

logger = logging.getLogger(__name__)

MY_WORK_PATH = "/me/work"


@dataclass(frozen=True)
class Landing:
    """Resolved front door. ``intent`` is the stable semantic target (clients map
    it to their own route); ``path`` is the concrete web route; ``resolved_by``
    explains the decision for honest first-login / "why am I here?" affordances.
    """

    intent: str  # "my_work" | "project_overview" | "portfolio"
    path: str
    resolved_by: str  # "preference" | "role_policy" | "fallback" | "demo_landing"


# --- Enterprise portfolio-access seam -------------------------------------
#
# OSS resolves ``portfolio`` to a real path only when the Enterprise overlay has
# registered a portfolio-access provider against this seam AND the running
# edition is Enterprise. The OSS core imports nothing from ``trueppm_enterprise``
# (the dependency is one-way, enterprise → core); absent a provider this returns
# False and the ``portfolio`` branch is never taken.

_portfolio_access_provider: Callable[[Any], bool] | None = None
_portfolio_path_provider: Callable[[Any], str] | None = None


def register_portfolio_access_provider(
    access: Callable[[Any], bool],
    path: Callable[[Any], str],
) -> None:
    """Enterprise registration hook: supply (is-entitled, resolve-path) callables.

    Called once at enterprise app-ready time. OSS never calls this, so
    ``has_portfolio_access`` stays False in the community edition.
    """

    global _portfolio_access_provider, _portfolio_path_provider
    _portfolio_access_provider = guard_single_provider(
        _portfolio_access_provider, access, "portfolio access"
    )
    _portfolio_path_provider = guard_single_provider(
        _portfolio_path_provider, path, "portfolio path"
    )


def has_portfolio_access(user: Any) -> bool:
    """True only when Enterprise edition is running and a registered provider
    grants this user portfolio entitlement. Always False in OSS."""

    if settings.TRUEPPM_EDITION != "enterprise" or _portfolio_access_provider is None:
        return False
    # A bad provider must not 500 /me; no access is the fallback.
    return bool(
        invoke_extension_provider(
            _portfolio_access_provider, user, hook="portfolio access", fallback=False
        )
    )


def _portfolio_path(user: Any) -> str | None:
    if _portfolio_path_provider is None:
        return None
    path: str | None = invoke_extension_provider(
        _portfolio_path_provider, user, hook="portfolio path", fallback=None
    )
    return path


# --- Helpers ---------------------------------------------------------------


def _overview_path(project_id: Any) -> str:
    return f"/projects/{project_id}/overview"


def most_recent_project(user: Any) -> Any | None:
    """The user's most recently *visited* accessible project (ADR-0150).

    Reads real last-visited telemetry from :class:`ProjectVisit` — the project
    the user most recently opened, filtered to ones they still belong to and that
    are not archived/deleted. One indexed query (``(user, -visited_at)``) on the
    ``/auth/me/`` hot path.

    Falls back to ``_most_recent_project_proxy`` (the highest-``server_version``
    membership, ADR-0129) when the user has no usable visit row yet — fresh users
    and existing users on their first navigation after this shipped. Returns the
    ``Project`` or None.
    """

    visit = (
        ProjectVisit.objects.filter(
            user=user,
            project__is_deleted=False,
            project__is_archived=False,
            # Only count visits to projects the user still has access to — a
            # membership may have been revoked since the visit was recorded.
            project__memberships__user=user,
            project__memberships__is_deleted=False,
        )
        .select_related("project")
        .order_by("-visited_at")
        .first()
    )
    if visit is not None:
        return visit.project
    return _most_recent_project_proxy(user)


def recent_projects(user: Any, limit: int = 5) -> list[Any]:
    """The user's most recently *visited* accessible projects (ADR-0150, ADR-0508).

    The list form of :func:`most_recent_project`, backing the ⌘K "Recent" group
    (#1557). Applies the *same* membership re-filter as the single-value resolver
    so a project the user was removed from, or that was archived/deleted, never
    surfaces from a stale visit row — the read is re-joined to live membership,
    not trusted from the visit table alone (the 🔴 IDOR guard from the VoC panel).

    One indexed query (``(user, -visited_at)``, ``projectvisit_user_recent_idx``)
    with ``project``/``program`` joined in, sliced server-side. ``limit`` is
    clamped to ``[1, 10]`` — this is a fixed navigation strip, not a search
    surface. Returns the :class:`ProjectVisit` rows (each carries ``.project`` and
    ``.visited_at``) newest-first; unlike ``most_recent_project`` there is no
    pre-telemetry proxy fallback — a user with no visit rows simply has an empty
    Recent group.
    """

    bounded = max(1, min(limit, 10))
    return list(
        ProjectVisit.objects.filter(
            user=user,
            project__is_deleted=False,
            project__is_archived=False,
            project__memberships__user=user,
            project__memberships__is_deleted=False,
        )
        .select_related("project", "project__program")
        .order_by("-visited_at")
        .distinct()[:bounded]
    )


def _most_recent_project_proxy(user: Any) -> Any | None:
    """Pre-telemetry fallback: highest-``server_version`` active membership.

    The ADR-0129 proxy — a stand-in for "most recently touched" used only until
    the user has a real :class:`ProjectVisit` row. Falls back to the
    alphabetically-first accessible project.
    """

    membership = (
        ProjectMembership.objects.filter(user=user, is_deleted=False)
        .select_related("project")
        .filter(project__is_deleted=False, project__is_archived=False)
        .order_by("-server_version", "project__name")
        .first()
    )
    return membership.project if membership is not None else None


def record_project_visit(user: Any, project: Any) -> None:
    """Upsert the user's last-visited timestamp for ``project`` (ADR-0150).

    Idempotent: keyed on the ``(user, project)`` unique constraint, so a repeat
    call only advances ``visited_at`` (last-writer-wins, the desired semantic).
    Best-effort — callers fire this fire-and-forget; it never raises into the
    request path on a benign race.
    """

    from django.db import IntegrityError
    from django.utils import timezone

    try:
        ProjectVisit.objects.update_or_create(
            user=user,
            project=project,
            defaults={"visited_at": timezone.now()},
        )
    except IntegrityError:  # pragma: no cover - concurrent first-write race; the row now exists
        ProjectVisit.objects.filter(user=user, project=project).update(visited_at=timezone.now())


def _max_project_role(user: Any) -> int | None:
    value = ProjectMembership.objects.filter(
        user=user, is_deleted=False, project__is_deleted=False
    ).aggregate(_max=Max("role"))["_max"]
    return int(value) if value is not None else None


def _has_any_membership(user: Any) -> bool:
    return (
        ProjectMembership.objects.filter(
            user=user, is_deleted=False, project__is_deleted=False
        ).exists()
        or ProgramMembership.objects.filter(
            user=user, is_deleted=False, program__is_deleted=False
        ).exists()
    )


# --- Public API ------------------------------------------------------------


def get_default_landing(user: Any) -> str:
    """The user's stored ``default_landing`` preference (``"auto"`` if no row)."""

    profile = UserProfile.objects.filter(user=user).only("default_landing").first()
    return profile.default_landing if profile is not None else DefaultLanding.AUTO


def get_hidden_views(user: Any) -> list[str]:
    """The user's stored ``hidden_views`` list (``[]`` if no row, ADR-0139)."""

    profile = UserProfile.objects.filter(user=user).only("hidden_views").first()
    return list(profile.hidden_views) if profile is not None else []


def get_profile_prefs(user: Any) -> tuple[str, list[str], str, str, str, str | None]:
    """All app preferences in one row read — ``(default_landing, hidden_views,
    role_context, timezone, date_format, home_override)``.

    ``/auth/me/`` surfaces all five fields, so reading them together (one
    ``.only()`` query) avoids extra ``UserProfile`` lookups per response. Returns
    the defaults (``AUTO``, ``[]``, ``UNIFIED``, ``"auto"``, ``AUTO``) when the user
    has no profile row yet — ``role_context`` defaults to the neutral dual-hat lens
    (#412, ADR-0162), and ``timezone`` / ``date_format`` to the ``"auto"`` sentinel
    (#1953, ADR-0410) that resolves client-side to the browser's zone/locale —
    matching the model defaults so an unconfigured user reads as "Unified Today" with
    zero-config browser-local display.

    ``schedule_in_deliver`` was the fourth element until ADR-0942 §3 / #3137 retired
    the Schedule-in-Deliver placement preference: every view now has exactly one home
    per render, so there is nothing left for the flag to place.
    """

    profile = (
        UserProfile.objects.filter(user=user)
        .only(
            "default_landing",
            "hidden_views",
            "role_context",
            "timezone",
            "date_format",
            "home_override",
        )
        .first()
    )
    if profile is None:
        return DefaultLanding.AUTO, [], RoleContext.UNIFIED, "auto", DateFormat.AUTO, None
    return (
        profile.default_landing,
        effective_hidden_views(user, list(profile.hidden_views)),
        profile.role_context,
        profile.timezone,
        profile.date_format,
        profile.home_override,
    )


_UNSET: Any = object()


def resolve_landing(user: Any, *, pref: Any = _UNSET, max_role: Any = _UNSET) -> Landing:
    """Resolve the front door for ``user``. Pure read; fails open to My Work.

    ``pref`` and ``max_role`` may be passed by a caller that has already computed
    them (e.g. ``MeSerializer`` reads both for other fields on the same request)
    so the resolver reuses them instead of re-querying — avoiding a duplicate
    ``UserProfile`` read and a duplicate ``Max(role)`` aggregate per ``/auth/me/``.
    Omit them and the resolver computes them itself.
    """

    try:
        return _resolve_landing(user, pref=pref, max_role=max_role)
    except Exception:  # defensive: the front door must never 500
        logger.exception("resolve_landing failed for user %s; falling back to My Work", user.pk)
        return Landing("my_work", MY_WORK_PATH, "fallback")


def _resolve_landing(user: Any, *, pref: Any = _UNSET, max_role: Any = _UNSET) -> Landing:
    if pref is _UNSET:
        pref = get_default_landing(user)
    enterprise = settings.TRUEPPM_EDITION == "enterprise"

    # 1. Explicit preference wins — honored when reachable, else falls through.
    preferred = _landing_from_preference(user, pref, enterprise)
    if preferred is not None:
        return preferred

    # 2. The published interactive-demo visitor lands on the demo's teaching
    #    project's Schedule (#4151) — a preference above still wins over this.
    demo_landing = _landing_for_demo_visitor(user)
    if demo_landing is not None:
        return demo_landing

    # 3. No memberships at all → onboarding via My Work's empty state.
    if not _has_any_membership(user):
        return Landing("my_work", MY_WORK_PATH, "fallback")

    # 4. AUTO role policy.
    return _landing_from_role_policy(user, enterprise, max_role)


def _is_demo_visitor(user: Any) -> bool:
    """Whether ``user`` is the interactive demo's one published account (#4151).

    Deliberately cheap when the answer is "no", which is every request on every
    normal install: ``settings.DEMO_READ_ONLY`` is a plain attribute read, and
    ``DEMO_LOGIN_HINT`` is parsed once at process start — neither costs a query, so
    this check adds nothing to the ``/auth/me/`` hot path outside an actual demo
    deployment.

    Identifies the account by comparing ``user.username`` against
    ``settings.DEMO_LOGIN_HINT["username"]`` — the same published credential
    ``GET /api/v1/edition/`` serves to the login screen (ADR-1197 D3) — rather than
    re-reading ``TRUEPPM_DEMO_LOGIN_USERNAME`` from the environment a second time.
    That env var is the *seed job's* input (``load_sample_project``); the hint is
    the runtime fact both the login page and this resolver need, and reading one
    settings value keeps the two from silently drifting apart.
    """
    if not settings.DEMO_READ_ONLY:
        return False
    hint = getattr(settings, "DEMO_LOGIN_HINT", None)
    if not hint:
        return False
    username = hint.get("username")
    return bool(username) and getattr(user, "username", None) == username


def _landing_for_demo_visitor(user: Any) -> Landing | None:
    """Land the published demo account on its teaching project's Schedule, or
    ``None`` to fall through to the normal policy (#4151, ADR-1197).

    The demo seeds one Member account (ADR-1197 D5) and the role policy would
    therefore send it to My Work like any other contributor — the same screen a
    real team member without deadlines lands on, and empty of the demo-ready
    schedule ``demo_landing_overlay`` spent an entire seed pass making healthy
    (#4050). A first-time visitor who never sees a schedule has not seen the
    product this demo exists to show.

    Uses ``"project_overview"`` as the ``intent`` (a project-scoped landing,
    exactly what that intent already means to the frontend) but resolves the
    concrete Schedule path directly rather than ``_overview_path`` — the point of
    this landing is the schedule view, not the dashboard — and tags
    ``resolved_by="demo_landing"`` so it is distinguishable from an ordinary
    role-policy resolution (and, deliberately, so ``LandingContextHint``'s
    role_policy/fallback copy does not fire for it — the demo bar already explains
    the mode).

    Returns ``None`` — not a 500, not a stale link — whenever the landing project
    is missing, archived, soft-deleted, or simply not readable by this user; the
    caller falls through to the ordinary policy in that case.
    """
    if not _is_demo_visitor(user):
        return None

    from trueppm_api.apps.projects.seed.demo_landing_overlay import (
        landing_project_for_demo_visitor,
    )

    project = landing_project_for_demo_visitor(user)
    if project is None:
        return None
    return Landing("project_overview", f"/projects/{project.pk}/schedule", "demo_landing")


def _landing_from_preference(user: Any, pref: Any, enterprise: bool) -> Landing | None:
    """Landing for an explicit preference, or ``None`` to fall through to policy."""
    if pref == DefaultLanding.MY_WORK:
        return Landing("my_work", MY_WORK_PATH, "preference")
    if pref == DefaultLanding.PROJECT_OVERVIEW:
        proj = most_recent_project(user)
        if proj is not None:
            return Landing("project_overview", _overview_path(proj.pk), "preference")
        # unreachable (no accessible project) → fall through to role policy
    if pref == DefaultLanding.PORTFOLIO and enterprise and has_portfolio_access(user):
        path = _portfolio_path(user)
        if path is not None:
            return Landing("portfolio", path, "preference")
        # provider gave no path → fall through
    return None


def _landing_from_role_policy(user: Any, enterprise: bool, max_role: Any) -> Landing:
    """AUTO role policy: Portfolio (entitled) → PM Overview → My Work."""
    #    PMO / Exec → Portfolio when entitled (Enterprise), else continue.
    if enterprise and has_portfolio_access(user):
        path = _portfolio_path(user)
        if path is not None:
            return Landing("portfolio", path, "role_policy")

    if max_role is _UNSET:
        max_role = _max_project_role(user)

    #    PM-type (SCHEDULER+) → most-recent project Overview.
    if max_role is not None and max_role >= Role.SCHEDULER:
        proj = most_recent_project(user)
        if proj is not None:
            return Landing("project_overview", _overview_path(proj.pk), "role_policy")
        return Landing("my_work", MY_WORK_PATH, "fallback")

    #    Contributor (MEMBER / VIEWER) → My Work.
    return Landing("my_work", MY_WORK_PATH, "role_policy")


# ---------------------------------------------------------------------------
# Shell-v2 home resolution (shell v2 home resolution)
# ---------------------------------------------------------------------------

HOME_CONTRIBUTOR = "contributor"
HOME_PM = "pm"
HOME_RM = "rm"
HOME_EXEC = "exec"

# A v1 landing the user chose explicitly maps onto the home of the same surface.
# Keyed on ``intent`` and read only when ``resolved_by == "preference"``, so a
# stored value ``_landing_from_preference`` does not honor (an OSS ``portfolio``,
# an unreachable ``project_overview``) falls through exactly as it does for v1.
_HOME_FOR_PREFERRED_INTENT = {
    "my_work": HOME_CONTRIBUTOR,
    "project_overview": HOME_PM,
    "portfolio": HOME_EXEC,
}


@dataclass(frozen=True)
class Home:
    """Resolved shell-v2 home. ``program`` is ``{id, code, name}`` or None; it is
    set only for ``exec``, whose home shows one program at a time."""

    home: str  # "contributor" | "pm" | "rm" | "exec"
    program: dict[str, str] | None = None


def _max_membership_role(user: Any, max_project_role: Any) -> int | None:
    """Highest Role ordinal across project AND program memberships."""
    if max_project_role is _UNSET:
        max_project_role = _max_project_role(user)
    program_role = ProgramMembership.objects.filter(
        user=user, is_deleted=False, program__is_deleted=False
    ).aggregate(_max=Max("role"))["_max"]
    roles = [int(r) for r in (max_project_role, program_role) if r is not None]
    return max(roles) if roles else None


def _has_my_work_assignment(user: Any) -> bool:
    """Whether ``/me/work`` would list at least one task for ``user``.

    Reuses ``MeWorkView``'s own "assigned to me" predicate (``Task.assignee`` OR a
    ``TaskResource`` on a ``Resource`` linked to the user) and its scope
    (non-BACKLOG, not soft-deleted, in a project the user still belongs to), so a
    Viewer the contributor page would show work to gets the contributor home. The
    issue's narrower "assignee only, not TaskResource" wording was deliberately
    widened to match what the page actually reads; a home that disagreed with the
    page it opens would land a resource-assigned Viewer on the Executive home.
    """
    from trueppm_api.apps.projects.models import Task, TaskStatus
    from trueppm_api.apps.projects.views import _my_work_assigned_q

    return (
        Task.objects.filter(
            _my_work_assigned_q(user.pk),
            is_deleted=False,
            project__is_deleted=False,
            project__memberships__user=user,
            project__memberships__is_deleted=False,
        )
        .exclude(status=TaskStatus.BACKLOG)
        .exists()
    )


def _program_payload(program: Any) -> dict[str, str]:
    return {"id": str(program.pk), "code": program.code, "name": program.name}


def resolve_home_program(user: Any) -> dict[str, str] | None:
    """The one program the Executive home opens on; the client selects nothing.

    The program of :func:`most_recent_project`, but only when the user holds a live
    ``ProgramMembership`` on it: the program rollup admits program members only, so
    a project Viewer inside a program they do not belong to would otherwise be sent
    to an overview that 404s. Else the first program by name among the user's live
    program memberships; else None.
    """
    from trueppm_api.apps.projects.models import Program

    member_programs = Program.objects.filter(
        is_deleted=False,
        pk__in=ProgramMembership.objects.filter(user=user, is_deleted=False).values("program_id"),
    )
    proj = most_recent_project(user)
    if proj is not None and proj.program_id is not None:
        program = member_programs.filter(pk=proj.program_id).first()
        if program is not None:
            return _program_payload(program)
    program = member_programs.order_by("name", "pk").first()
    return _program_payload(program) if program is not None else None


def resolve_home(
    user: Any,
    landing: Landing,
    *,
    home_override: Any = _UNSET,
    max_role: Any = _UNSET,
) -> Home:
    """Resolve the shell-v2 home for ``user``. Pure read; fails open to Contributor.

    ``landing`` is the v1 :func:`resolve_landing` result for the same request; the
    preference and demo steps read it so the two resolvers can never disagree about
    which preference was honored. Precedence (shell v2, behind the shell_v2 web flag):

    1. ``home_override`` (``rm``);
    2. an honored ``default_landing`` preference (my_work → contributor,
       project_overview → pm, portfolio → exec);
    3. the demo visitor → pm;
    4. no memberships → contributor;
    5. the max role across project and program memberships: Scheduler+ → pm;
       Member, or any ``/me/work`` assignment → contributor; Viewer-only → exec.

    ``max_role`` is the caller's already-computed max *project* role.
    """
    try:
        home = _resolve_home(user, landing, home_override=home_override, max_role=max_role)
        if home == HOME_EXEC:
            return Home(home, resolve_home_program(user))
        return Home(home)
    except Exception:  # defensive: /auth/me/ must never 500 on the home
        logger.exception("resolve_home failed for user %s; falling back to contributor", user.pk)
        return Home(HOME_CONTRIBUTOR)


def _resolve_home(user: Any, landing: Landing, *, home_override: Any, max_role: Any) -> str:
    if home_override is _UNSET:
        profile = UserProfile.objects.filter(user=user).only("home_override").first()
        home_override = profile.home_override if profile is not None else None
    if home_override == HomeOverride.RM:
        return HOME_RM

    if landing.resolved_by == "preference":
        preferred = _HOME_FOR_PREFERRED_INTENT.get(landing.intent)
        if preferred is not None:
            return preferred

    if landing.resolved_by == "demo_landing":
        return HOME_PM

    role = _max_membership_role(user, max_role)
    if role is None:
        return HOME_CONTRIBUTOR
    # A Scheduler+ with no recent project is still pm; only ``path`` falls back.
    if role >= Role.SCHEDULER:
        return HOME_PM
    if role >= Role.MEMBER or _has_my_work_assignment(user):
        return HOME_CONTRIBUTOR
    return HOME_EXEC


# ---------------------------------------------------------------------------
# Per-user pins (#2390, ADR-0627)
# ---------------------------------------------------------------------------


class PinLimitReached(Exception):
    """Raised when a pin would exceed ``TRUEPPM_MAX_USER_PINS`` for this user.

    Carries the cap so the view can name the actual limit in its message rather
    than hardcoding a number that an operator may have overridden.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(f"User has reached the maximum of {limit} pinned items.")


def set_pin(user: Any, *, project: Any = None, program: Any = None, pinned: bool) -> bool:
    """Pin or unpin one project *or* one program for ``user``.

    Returns whether the pin exists after the call, so the caller can echo the
    resulting state without a second query. Idempotent in both directions: a
    repeated pin is a no-op that still reports ``True``, and unpinning something
    that was never pinned reports ``False`` rather than 404 — a pin is a personal
    preference, and making its absence an error would surface a race between two
    of the user's own tabs as a failure.

    The cap is checked only when *adding*, and only when the row does not already
    exist, so a user sitting exactly at the limit can still unpin and re-pin.

    Scoped entirely to ``user``; there is no code path here that reads or writes
    another user's pins (ADR-0627 §D5).
    """
    from django.conf import settings

    from trueppm_api.apps.profiles.models import UserPin

    if (project is None) == (program is None):
        raise ValueError("set_pin requires exactly one of project= or program=")

    target = {"project": project} if project is not None else {"program": program}

    if not pinned:
        UserPin.objects.filter(user=user, **target).delete()
        return False

    existing = UserPin.objects.filter(user=user, **target).first()
    if existing is not None:
        return True

    limit = settings.TRUEPPM_MAX_USER_PINS
    if UserPin.objects.filter(user=user).count() >= limit:
        raise PinLimitReached(limit)

    # get_or_create rather than create: two concurrent pins of the same target
    # (double-click, or two tabs) would otherwise race past the `existing` check
    # into an IntegrityError on the partial unique constraint.
    UserPin.objects.get_or_create(user=user, **target)
    return True


_QS = TypeVar("_QS", bound=QuerySet[Any, Any])


def annotate_is_pinned(queryset: _QS, user: Any, *, field: str = "project") -> _QS:
    """Annotate ``is_pinned`` for ``user`` onto a Project or Program queryset.

    The subquery is bound to ``user`` **positionally** — it is a closed-over
    value, not a request parameter — which is the structural reason this
    annotation can answer "did *I* pin this" and can never be coerced into
    answering "did someone else pin this" (ADR-0627 §D5). Any future change that
    threads a caller-supplied user id in here is a privacy regression and needs a
    superseding ADR.

    ``field`` selects which FK on ``UserPin`` to match — ``"project"`` or
    ``"program"``. Both are covered by a partial unique index, so the Exists()
    probe is an index lookup rather than a scan.
    """
    from django.db.models import BooleanField, Exists, OuterRef, Value

    from trueppm_api.apps.profiles.models import UserPin

    if not getattr(user, "is_authenticated", False):
        # Anonymous reads (public share links) never carry a pin state.
        return queryset.annotate(is_pinned=Value(False, output_field=BooleanField()))

    return queryset.annotate(
        is_pinned=Exists(
            UserPin.objects.filter(user=user, **{field: OuterRef("pk")}),
        )
    )


# ---------------------------------------------------------------------------
# Resolved project view set (ADR-1478)
# ---------------------------------------------------------------------------


class LastPlanLayoutError(Exception):
    """A write would leave the Plan tab with no layout (ADR-1478 §3, ``last_plan_layout``)."""


@dataclass(frozen=True)
class ResolvedView:
    """One view's resolved visibility and the reason for it (ADR-1478 §3).

    ``binding`` is a UI contract, not API authorization: ``enforced`` means only that the
    workspace turned the area off (#4888) and the web shows AreaOff. Every other
    hidden view is ``advisory`` and still opens from More and by URL.
    """

    key: str
    visible: bool
    source: str
    binding: str = "advisory"
    lens: str | None = None
    at: str | None = None


@dataclass(frozen=True)
class ResolvedViewSet:
    """``GET /projects/{id}/views/``: every view plus the row-3 explainer state."""

    views: list[ResolvedView]
    lens: str
    seeded_lens: str | None
    seed_line: dict[str, Any] | None
    lens_offer: str | None
    landing: str | None
    last_layouts: dict[str, str]


def is_allocation_manager(user: Any, workspace: Any = None) -> bool:
    """Whether ``user`` manages a capacity pool (#3122), so no seed hides People.

    Capacity pools do not exist yet; this returns ``False`` until #3122 implements it.
    A person's own hide of ``resources`` is honored either way (Q1.7).
    """

    del user, workspace
    return False


def _workspace_off_views(project: Any) -> frozenset[str]:
    """Views the workspace turned off (#4888): ``source: capability, binding: enforced``.

    The server-side area switch is not built yet (#4888), so nothing is off and the
    resolver degrades to the other sources, as ADR-1478 §3 allows.
    """

    del project
    return frozenset()  # TODO(#4888): read the workspace's disabled areas.


def _methodology_hidden(methodology: str) -> frozenset[str]:
    """The advisory methodology default, minus what the shell v2 Plan rule keeps (Schedule)."""

    return METHODOLOGY_HIDDEN_VIEWS.get(methodology, frozenset()) - METHODOLOGY_NEVER_HIDES


def _role_context(user: Any) -> str:
    profile = UserProfile.objects.filter(user=user).only("role_context").first()
    return profile.role_context if profile is not None else RoleContext.UNIFIED


def _entry(view: str, *, source: str, hidden: bool, lens: str | None, at: str) -> dict[str, Any]:
    return {"view": view, "hidden": hidden, "source": source, "lens": lens, "at": at}


def _seed_entries(lens: str, methodology: str, user: Any, now: str) -> list[dict[str, Any]]:
    """The lens seed as stored entries, narrowed by methodology and the People guard.

    A seed key that is not hideable (retired by a view-inventory change, or never valid)
    is ignored and logged rather than raising, so the registry can outlive a key.
    Keys the methodology already hides are not recorded: the seed narrows only.
    """

    seed = LENS_VIEW_SEEDS.get(lens)
    if seed is None:
        return []
    keys: set[str] = set()
    for key in seed.hide:
        if key not in HIDEABLE_VIEW_KEYS:
            logger.warning("LENS_VIEW_SEEDS[%s] names non-hideable view %r; ignored", lens, key)
            continue
        keys.add(key)
    keys -= _methodology_hidden(methodology)
    if "resources" in keys and is_allocation_manager(user):
        keys.discard("resources")
    return [_entry(k, source="seed", hidden=True, lens=lens, at=now) for k in sorted(keys)]


def _by_view(hides: Any) -> dict[str, dict[str, Any]]:
    """Index stored entries by view; a ``user`` entry wins over a ``seed`` one."""

    out: dict[str, dict[str, Any]] = {}
    for e in hides if isinstance(hides, list) else []:
        if not isinstance(e, dict) or e.get("view") not in HIDEABLE_VIEW_KEYS:
            continue
        prev = out.get(e["view"])
        if prev is None or e.get("source") == "user":
            out[e["view"]] = e
    return out


def _resolve_entries(
    hides: Any, methodology: str, off: frozenset[str], *, fallback: bool = True
) -> list[ResolvedView]:
    """Apply ADR-1478 §3 precedence to one stored entry list.

    TODO(#3122): once ``is_allocation_manager`` is real, also drop a stored ``seed``
    entry for ``resources`` here for an allocation manager. The People guard runs only
    when a seed is written (``_seed_entries``), so a seed stored before the user became
    a pool manager would otherwise keep hiding People.

    Order: always-on, then the workspace area switch (the only ``enforced`` source),
    then the user's own entry, then the seed, then the methodology default. With
    ``fallback`` the never-empty rule shows ``schedule`` (``source: always``) when no
    Plan layout would otherwise be visible; writers call it with ``fallback=False``
    to detect and refuse that state instead.
    """

    entries = _by_view(hides)
    m_hidden = _methodology_hidden(methodology)
    views: list[ResolvedView] = []
    for key in RESOLVED_VIEW_ORDER:
        e = entries.get(key)
        if key in ALWAYS_ON_VIEW_KEYS:
            views.append(ResolvedView(key, True, "always"))
        elif key in off:
            views.append(ResolvedView(key, False, "capability", "enforced"))
        elif e is not None and e.get("source") == "user":
            views.append(ResolvedView(key, not e.get("hidden", True), "user", at=e.get("at")))
        elif e is not None and e.get("source") == "seed":
            views.append(ResolvedView(key, False, "seed", lens=e.get("lens"), at=e.get("at")))
        elif key in m_hidden:
            views.append(ResolvedView(key, False, "methodology"))
        else:
            views.append(ResolvedView(key, True, "default"))
    if fallback and not any(v.visible for v in views if v.key in PLAN_LAYOUT_KEYS):
        views = [ResolvedView(v.key, True, "always") if v.key == "schedule" else v for v in views]
    return views


def _plan_left(hides: Any, methodology: str, off: frozenset[str]) -> bool:
    views = _resolve_entries(hides, methodology, off, fallback=False)
    return any(v.visible for v in views if v.key in PLAN_LAYOUT_KEYS)


def _landing(lens: str, methodology: str, views: list[ResolvedView]) -> str | None:
    seed = LENS_VIEW_SEEDS.get(lens)
    target = seed.landing.get(methodology) if seed is not None else None
    visible = {v.key for v in views if v.visible}
    return target if target in visible else None


def _build(state: ProjectViewState, lens: str, project: Any) -> ResolvedViewSet:
    off = _workspace_off_views(project)
    views = _resolve_entries(state.hides, project.methodology, off)
    seeded = [v for v in views if v.source == "seed"]
    # ``seeded_lens`` is the lens the row was resolved under, recorded even when that
    # lens's seed came out empty (e.g. a pm on Waterfall). So the seed line keys on
    # there being seed entries, and the offer keys on the lens having changed since.
    resolved_under = state.seeded_lens or None
    # The API's ``seeded_lens`` keeps its documented meaning: the lens whose seed is
    # in effect, so null when no seed entry survives.
    seeded_lens = resolved_under if seeded else None
    seed_line = None
    if seeded_lens and state.seed_line_dismissed_at is None:
        seed_line = {"lens": seeded_lens, "hidden_count": len(seeded)}
    lens_offer = None
    if (
        resolved_under is not None
        and lens != resolved_under
        and state.lens_offer_dismissed_for != lens
        and lens in LENS_VIEW_SEEDS
    ):
        lens_offer = lens
    return ResolvedViewSet(
        views=views,
        lens=lens,
        seeded_lens=seeded_lens,
        seed_line=seed_line,
        lens_offer=lens_offer,
        landing=_landing(lens, project.methodology, views),
        last_layouts=dict(state.last_layouts or {}),
    )


def _fail_open(lens: str, project: Any) -> ResolvedViewSet:
    off = _workspace_off_views(project)
    views = [
        ResolvedView(k, True, "always")
        if k in ALWAYS_ON_VIEW_KEYS
        else ResolvedView(k, False, "capability", "enforced")
        if k in off
        else ResolvedView(k, True, "default")
        for k in RESOLVED_VIEW_ORDER
    ]
    return ResolvedViewSet(views, lens, None, None, None, None, {})


def resolve_project_views(user: Any, project: Any, *, persist: bool = True) -> ResolvedViewSet:
    """The caller's resolved view set for ``project``, seeding it on first resolve.

    The first read for a ``(user, project)`` creates the row with the current lens's
    seed (ADR-1478 §4). It is a write on first read on purpose: membership is created
    on many paths, and a seed hooked into each would be missed on the next one added.
    ``get_or_create`` under the unique constraint makes concurrent first reads seed
    once. If that write fails the resolver **fails open** — every allowed view,
    ``source: default`` — and writes nothing, so the next read seeds.

    Changing the lens later never re-seeds (Q5.2): it only raises ``lens_offer``.

    ``persist=False`` is the agent (MCP) read: it answers with the seed the first web
    read *would* write, from an unsaved row, and writes nothing. Seeding is permanent
    (a later lens change never re-seeds), so letting an ``mcp:read`` token write it
    would freeze the user's seed at whatever lens they held when an agent first asked,
    and a read-scoped credential would be making a write.
    """

    lens = _role_context(user)
    if not persist:
        existing = ProjectViewState.objects.filter(user=user, project=project).first()
        if existing is None:
            existing = ProjectViewState(
                user=user, project=project, **_seed_defaults(user, project, lens)
            )
        else:
            _complete_pending_seed(existing, user, project, lens)  # in memory only
        return _build(existing, lens, project)
    try:
        with transaction.atomic():
            state = _get_or_create_state(user, project, lens)
            if not state.seeded_lens:
                state = _locked_state(user, project, lens)
    except DatabaseError:
        logger.warning(
            "view seed failed for user=%s project=%s; failing open",
            getattr(user, "pk", None),
            getattr(project, "pk", None),
            exc_info=True,
        )
        return _fail_open(lens, project)
    return _build(state, lens, project)


def _get_or_create_state(user: Any, project: Any, lens: str) -> ProjectViewState:
    """The caller's row, building seed defaults only when it is missing.

    ``get_or_create(defaults=...)`` evaluates its defaults on every call, which would
    add a ``UserProfile`` read to every warm resolve. The unique constraint keeps the
    create race-safe; the loser of a race reads the winner's row.
    """

    state = ProjectViewState.objects.filter(user=user, project=project).first()
    if state is not None:
        return state
    try:
        with transaction.atomic():
            return ProjectViewState.objects.create(
                user=user, project=project, **_seed_defaults(user, project, lens)
            )
    except IntegrityError:
        return ProjectViewState.objects.get(user=user, project=project)


def _seed_defaults(user: Any, project: Any, lens: str) -> dict[str, Any]:
    """A new row: the stored legacy ``hidden_views`` as ``user`` entries, then the seed.

    The stored list is carried in only when the user has no row on a live membership,
    the case a legacy fan-out could not reach: a list written with no live membership
    (Settings › Me before the first project, or after every membership ended) would
    otherwise be dropped on the first open, and the deprecated read, which reports only
    ``user`` entries once any row exists, would go back to ``[]``. Once the user has a
    row, their per-project v2 choices outrank the older list, so a later project is
    seeded without it. The carried row is what the fan-out would have created,
    completed as ``_complete_pending_seed`` completes one.
    """

    now = timezone.now()
    at = now.isoformat()
    has_live_row = ProjectViewState.objects.filter(
        user=user,
        project__is_deleted=False,
        project__memberships__user=user,
        project__memberships__is_deleted=False,
    ).exists()
    stored = [] if has_live_row else get_hidden_views(user)
    user_entries = [
        _entry(k, source="user", hidden=True, lens=None, at=at)
        for k in sorted({k for k in stored if k in HIDEABLE_VIEW_KEYS})
    ]
    user_keys = {e["view"] for e in user_entries}
    seed = [
        e for e in _seed_entries(lens, project.methodology, user, at) if e["view"] not in user_keys
    ]
    return {
        "hides": user_entries + seed,
        # Always the lens resolved under, even with no entries: an empty value means
        # "not resolved yet" (a legacy fan-out row), and the lens offer compares to it.
        "seeded_lens": lens,
        "seeded_at": now if seed else None,
    }


def _complete_pending_seed(state: ProjectViewState, user: Any, project: Any, lens: str) -> bool:
    """Seed a row that a legacy ``hidden_views`` fan-out created before any resolve.

    Such a row holds only the user's own hides and an empty ``seeded_lens``. The first
    resolve of the project still applies the lens seed (ADR-1478 §6 step 2), around the
    user's entries, which always win. Returns whether ``state`` changed (unsaved).
    """

    if state.seeded_lens:
        return False
    now = timezone.now()
    user_entries = [e for e in _by_view(state.hides).values() if e["source"] == "user"]
    user_keys = {e["view"] for e in user_entries}
    seed = [
        e for e in _seed_entries(lens, project.methodology, user, now.isoformat())
        if e["view"] not in user_keys
    ]  # fmt: skip
    state.hides = user_entries + seed
    state.seeded_lens = lens
    state.seeded_at = now if seed else None
    return True


def _locked_state(user: Any, project: Any, lens: str | None = None) -> ProjectViewState:
    """The caller's own row, seeded if new or still pending, locked for a replace."""

    lens = lens or _role_context(user)
    _get_or_create_state(user, project, lens)
    state = ProjectViewState.objects.select_for_update().get(user=user, project=project)
    if _complete_pending_seed(state, user, project, lens):
        state.save(update_fields=["hides", "seeded_lens", "seeded_at", "updated_at"])
    return state


def set_view_hidden(user: Any, project: Any, key: str, hidden: bool) -> None:
    """Record the user's own choice for ``key`` (overrides any seed entry for it).

    Raises :class:`LastPlanLayoutError` when hiding ``key`` would leave Plan empty.
    """

    with transaction.atomic():
        state = _locked_state(user, project)
        now = timezone.now().isoformat()
        hides = [e for e in _by_view(state.hides).values() if e["view"] != key]
        hides.append(_entry(key, source="user", hidden=hidden, lens=None, at=now))
        if hidden and not _plan_left(hides, project.methodology, _workspace_off_views(project)):
            raise LastPlanLayoutError(key)
        state.hides = hides
        state.save(update_fields=["hides", "updated_at"])


def update_view_state_flags(
    user: Any,
    project: Any,
    *,
    seed_line_dismissed: bool = False,
    lens_offer_dismissed: str | None = None,
    last_layouts: dict[str, str] | None = None,
    clear_seed: bool = False,
) -> None:
    """Persist the explainer/offer dismissals, remembered layouts, or "Show all".

    ``clear_seed`` is the row-3 "Show all": it drops only ``seed`` entries for this
    project and dismisses the seed line. ``user`` entries are untouched, and because
    the row already exists nothing re-seeds.
    """

    with transaction.atomic():
        state = _locked_state(user, project)
        fields = ["updated_at"]
        if seed_line_dismissed or clear_seed:
            state.seed_line_dismissed_at = timezone.now()
            fields.append("seed_line_dismissed_at")
        if clear_seed:
            state.hides = [e for e in _by_view(state.hides).values() if e["source"] == "user"]
            fields.append("hides")
        if lens_offer_dismissed is not None:
            state.lens_offer_dismissed_for = lens_offer_dismissed
            fields.append("lens_offer_dismissed_for")
        if last_layouts is not None:
            # Bounded across requests, not only per request: each PATCH may add keys, so
            # keep the most recent 16 rather than let the JSON grow without limit.
            merged = {**(state.last_layouts or {}), **last_layouts}
            state.last_layouts = dict(list(merged.items())[-16:])
            fields.append("last_layouts")
        state.save(update_fields=fields)


def apply_lens_seed(user: Any, project: Any, lens: str, *, dry_run: bool) -> dict[str, Any]:
    """Rewrite only the ``seed`` entries to ``lens``'s seed; return the diff (1C).

    The diff names what will hide, what will reappear, where the project will open,
    and the user's own choices that are **kept** — so the confirm can show them
    surviving. Raises :class:`LastPlanLayoutError` if the result would empty Plan.
    ``POST …/views/reset/`` is this with the current lens.
    """

    with transaction.atomic():
        state = _locked_state(user, project)
        entries = _by_view(state.hides)
        user_entries = [e for e in entries.values() if e["source"] == "user"]
        user_keys = {e["view"] for e in user_entries}
        old_seed = {e["view"] for e in entries.values() if e["source"] == "seed"}
        now = timezone.now()
        new_seed = [
            e for e in _seed_entries(lens, project.methodology, user, now.isoformat())
            if e["view"] not in user_keys
        ]  # fmt: skip
        new_keys = {e["view"] for e in new_seed}
        hides = user_entries + new_seed
        off = _workspace_off_views(project)
        if not _plan_left(hides, project.methodology, off):
            raise LastPlanLayoutError(lens)
        views = _resolve_entries(hides, project.methodology, off)
        will_hide = sorted(new_keys - old_seed)
        will_show = sorted(old_seed - new_keys)
        diff: dict[str, Any] = {
            "lens": lens,
            "will_hide": will_hide,
            "will_show": will_show,
            "will_open_on": _landing(lens, project.methodology, views),
            "kept": [{"view": e["view"], "hidden": bool(e.get("hidden"))} for e in user_entries],
            "change_count": len(will_hide) + len(will_show),
            "applied": not dry_run,
        }
        if not dry_run:
            state.hides = hides
            # Recorded even for a zero-change apply, so the offer it answered clears.
            state.seeded_lens = lens
            state.seeded_at = now if new_seed else None
            state.lens_offer_dismissed_for = ""
            state.save(
                update_fields=[
                    "hides", "seeded_lens", "seeded_at", "lens_offer_dismissed_for", "updated_at",
                ]
            )  # fmt: skip
        return diff


def reset_project_views(user: Any, project: Any) -> dict[str, Any]:
    """Restore the current lens's seed; ``user`` entries are left alone (1B Reset)."""

    return apply_lens_seed(user, project, _role_context(user), dry_run=False)


def _live_member_project_ids(user: Any) -> QuerySet[Any]:
    return ProjectMembership.objects.filter(
        user=user, is_deleted=False, project__is_deleted=False
    ).values_list("project_id", flat=True)


def effective_hidden_views(user: Any, stored: list[str]) -> list[str]:
    """The deprecated ``hidden_views`` read (ADR-1478 §6.2): user-sourced hides only.

    The de-duplicated union of the user's ``source: "user"`` hides across their live
    projects — never the seeded ones. A user with no view-state rows yet (no project,
    or none opened since the upgrade) reads the stored legacy list, which is what the
    v1 shell wrote last.
    """

    rows = ProjectViewState.objects.filter(
        user=user, project_id__in=_live_member_project_ids(user)
    ).values_list("hides", flat=True)
    found = False
    keys: set[str] = set()
    for hides in rows:
        found = True
        keys.update(
            e["view"] for e in _by_view(hides).values() if e["source"] == "user" and e["hidden"]
        )
    return sorted(keys) if found else list(stored)


def fan_out_hidden_views(user: Any, keys: list[str]) -> None:
    """Apply a legacy ``PATCH {hidden_views}`` to every project the user belongs to.

    Today's global semantics, re-expressed per project for one minor release so the v1
    shell keeps working (ADR-1478 §6.2): the listed keys become ``user`` hides, and
    ``user`` hides not listed are cleared. ``seed`` entries for unlisted keys and a
    user's explicit "keep shown" entries are untouched. Rows that do not exist yet are
    created with only those hides and an empty ``seeded_lens`` ("not resolved yet"), so
    the project's first open still applies the lens seed around them
    (``_complete_pending_seed``). One bulk insert, one locked read and one bulk update,
    O(memberships).

    A list that hides every Plan layout is accepted, not refused with
    ``last_plan_layout``: in the v1 shell, still the default, Schedule, Grid and
    Calendar are separate tabs and hiding all three is a legal state, and ADR-1478
    §6.2 keeps this write working unchanged. The v2 resolver shows ``schedule`` with
    ``source: always`` instead, so Plan is never empty.
    """

    wanted = set(keys)
    now = timezone.now().isoformat()
    project_ids = set(_live_member_project_ids(user))
    with transaction.atomic():
        # Insert the missing rows empty first, then lock and rewrite every row. Rows
        # inserted with their hides after a locked read would lose them to a first
        # resolve that created the same row in between: ``ignore_conflicts`` skips the
        # insert silently, and that row was never in the locked set.
        ProjectViewState.objects.bulk_create(
            [ProjectViewState(user=user, project_id=pid) for pid in project_ids],
            ignore_conflicts=True,
        )
        rows = list(
            ProjectViewState.objects.select_for_update().filter(
                user=user, project_id__in=project_ids
            )
        )
        for state in rows:
            kept = [
                e
                for e in _by_view(state.hides).values()
                if e["view"] not in wanted and not (e["source"] == "user" and e["hidden"])
            ]
            state.hides = kept + [
                _entry(k, source="user", hidden=True, lens=None, at=now) for k in sorted(wanted)
            ]
        ProjectViewState.objects.bulk_update(rows, ["hides"])
