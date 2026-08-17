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
2. A user with no project/program membership lands on My Work (its onboarding
   empty state) — never pushed into project creation.
3. Otherwise the role policy: PMO/Exec (portfolio-entitled, Enterprise) →
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
from django.db.models import Max, QuerySet

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.models import (
    DateFormat,
    DefaultLanding,
    ProjectVisit,
    RoleContext,
    UserProfile,
)
from trueppm_api.core.extension_providers import guard_single_provider

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
    resolved_by: str  # "preference" | "role_policy" | "fallback"


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
    try:
        return bool(_portfolio_access_provider(user))
    except Exception:  # pragma: no cover - defensive: a bad provider must not 500 /me
        logger.exception("portfolio access provider raised; treating as no access")
        return False


def _portfolio_path(user: Any) -> str | None:
    if _portfolio_path_provider is None:
        return None
    try:
        return _portfolio_path_provider(user)
    except Exception:  # pragma: no cover - defensive
        logger.exception("portfolio path provider raised")
        return None


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
    value = ProjectMembership.objects.filter(user=user, is_deleted=False).aggregate(
        _max=Max("role")
    )["_max"]
    return int(value) if value is not None else None


def _has_any_membership(user: Any) -> bool:
    return (
        ProjectMembership.objects.filter(user=user, is_deleted=False).exists()
        or ProgramMembership.objects.filter(user=user, is_deleted=False).exists()
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


def get_profile_prefs(user: Any) -> tuple[str, list[str], str, bool, str, str]:
    """All app preferences in one row read — ``(default_landing, hidden_views,
    role_context, schedule_in_deliver, timezone, date_format)``.

    ``/auth/me/`` surfaces all six fields, so reading them together (one
    ``.only()`` query) avoids extra ``UserProfile`` lookups per response. Returns
    the defaults (``AUTO``, ``[]``, ``UNIFIED``, ``False``, ``"auto"``, ``AUTO``)
    when the user has no profile row yet — ``role_context`` defaults to the neutral
    dual-hat lens (#412, ADR-0162), ``schedule_in_deliver`` to off (ADR-0203,
    #1645), and ``timezone`` / ``date_format`` to the ``"auto"`` sentinel (#1953,
    ADR-0410) that resolves client-side to the browser's zone/locale — matching the
    model defaults so an unconfigured user reads as "Unified Today", the calm
    Schedule-in-Plan-only default, and zero-config browser-local display.
    """

    profile = (
        UserProfile.objects.filter(user=user)
        .only(
            "default_landing",
            "hidden_views",
            "role_context",
            "schedule_in_deliver",
            "timezone",
            "date_format",
        )
        .first()
    )
    if profile is None:
        return DefaultLanding.AUTO, [], RoleContext.UNIFIED, False, "auto", DateFormat.AUTO
    return (
        profile.default_landing,
        list(profile.hidden_views),
        profile.role_context,
        profile.schedule_in_deliver,
        profile.timezone,
        profile.date_format,
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

    # 2. No memberships at all → onboarding via My Work's empty state.
    if not _has_any_membership(user):
        return Landing("my_work", MY_WORK_PATH, "fallback")

    # 3. AUTO role policy.
    return _landing_from_role_policy(user, enterprise, max_role)


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
