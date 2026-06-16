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
from typing import Any

from django.conf import settings
from django.db.models import Max

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.models import DefaultLanding, UserProfile

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
    _portfolio_access_provider = access
    _portfolio_path_provider = path


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
    """Best-effort "most recently active project" for a PM-type user.

    There is no per-user last-visited tracking today, so this uses the
    highest-``server_version`` active membership (a proxy for "most recently
    touched") and falls back to the alphabetically-first project. Good enough for
    a *default* the user can override; real last-visited telemetry is a tracked
    follow-up. Returns the ``Project`` or None.
    """

    membership = (
        ProjectMembership.objects.filter(user=user, is_deleted=False)
        .select_related("project")
        .filter(project__is_deleted=False, project__is_archived=False)
        .order_by("-server_version", "project__name")
        .first()
    )
    return membership.project if membership is not None else None


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

    # 2. No memberships at all → onboarding via My Work's empty state.
    if not _has_any_membership(user):
        return Landing("my_work", MY_WORK_PATH, "fallback")

    # 3. AUTO role policy.
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
