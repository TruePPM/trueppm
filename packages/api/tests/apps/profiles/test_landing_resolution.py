"""Tests for the role-based landing resolver (ADR-0129).

Covers the policy matrix (contributor / PM / no-membership), the preference
escape hatch, unreachable-preference fallthrough, the Enterprise portfolio seam,
and the fail-open guarantee.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.models import DefaultLanding, UserProfile
from trueppm_api.apps.profiles.services import resolve_landing
from trueppm_api.apps.projects.models import Calendar, Program, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project(name: str = "P1") -> Project:
    cal = Calendar.objects.create(name=f"Cal-{name}")
    return Project.objects.create(name=name, start_date=date(2026, 1, 1), calendar=cal)


def _user(username: str) -> User:
    return User.objects.create_user(username=username, password="pw")


def _set_pref(user: User, value: str) -> None:
    UserProfile.objects.update_or_create(user=user, defaults={"default_landing": value})


# ---------------------------------------------------------------------------
# AUTO role policy
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_contributor_member_lands_on_my_work() -> None:
    user = _user("priya")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)

    landing = resolve_landing(user)
    assert landing.intent == "my_work"
    assert landing.path == "/me/work"
    assert landing.resolved_by == "role_policy"


@pytest.mark.django_db
def test_viewer_lands_on_my_work() -> None:
    user = _user("vince")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.VIEWER)

    assert resolve_landing(user).intent == "my_work"


@pytest.mark.django_db
def test_scheduler_lands_on_project_overview() -> None:
    user = _user("dave")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.SCHEDULER)

    landing = resolve_landing(user)
    assert landing.intent == "project_overview"
    assert landing.path == f"/projects/{proj.pk}/overview"
    assert landing.resolved_by == "role_policy"


@pytest.mark.django_db
def test_admin_lands_on_project_overview() -> None:
    user = _user("sarah")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.ADMIN)

    assert resolve_landing(user).intent == "project_overview"


@pytest.mark.django_db
def test_max_role_across_memberships_decides_pm() -> None:
    """ADMIN on one project + MEMBER on ten → still a PM (uses MAX ordinal)."""
    user = _user("multi")
    admin_proj = _project("Admin")
    ProjectMembership.objects.create(project=admin_proj, user=user, role=Role.ADMIN)
    for i in range(3):
        ProjectMembership.objects.create(project=_project(f"M{i}"), user=user, role=Role.MEMBER)

    assert resolve_landing(user).intent == "project_overview"


@pytest.mark.django_db
def test_no_membership_lands_on_my_work_fallback() -> None:
    """A brand-new / just-invited user with no memberships gets My Work onboarding."""
    user = _user("newbie")

    landing = resolve_landing(user)
    assert landing.intent == "my_work"
    assert landing.resolved_by == "fallback"


@pytest.mark.django_db
def test_program_only_member_is_not_zero_membership() -> None:
    """A program member with no project membership still has membership → role policy."""
    user = _user("progonly")
    program = Program.objects.create(name="Apollo")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)

    landing = resolve_landing(user)
    # No project role → contributor bucket → My Work, but by role_policy not fallback.
    assert landing.intent == "my_work"
    assert landing.resolved_by == "role_policy"


@pytest.mark.django_db
def test_pm_with_only_archived_project_falls_back_to_my_work() -> None:
    """A PM whose only project is archived should not land on a read-only archive."""
    user = _user("archived_pm")
    cal = Calendar.objects.create(name="Cal-Arch")
    proj = Project.objects.create(
        name="Archived", start_date=date(2026, 1, 1), calendar=cal, is_archived=True
    )
    ProjectMembership.objects.create(project=proj, user=user, role=Role.ADMIN)

    landing = resolve_landing(user)
    assert landing.intent == "my_work"
    assert landing.resolved_by == "fallback"


@pytest.mark.django_db
def test_passed_pref_and_max_role_match_self_computed() -> None:
    """The MeSerializer fast path (pref + max_role passed in) must equal the
    self-computed result — the dedup must not change the verdict."""
    user = _user("dedup")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.ADMIN)

    computed = resolve_landing(user)
    passed = resolve_landing(user, pref=DefaultLanding.AUTO, max_role=Role.ADMIN)
    assert (passed.intent, passed.path, passed.resolved_by) == (
        computed.intent,
        computed.path,
        computed.resolved_by,
    )


# ---------------------------------------------------------------------------
# Preference escape hatch
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_preference_my_work_overrides_pm_role() -> None:
    user = _user("pm_wants_tasks")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.ADMIN)
    _set_pref(user, DefaultLanding.MY_WORK)

    landing = resolve_landing(user)
    assert landing.intent == "my_work"
    assert landing.resolved_by == "preference"


@pytest.mark.django_db
def test_preference_project_overview_overrides_contributor_role() -> None:
    user = _user("member_wants_project")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.MEMBER)
    _set_pref(user, DefaultLanding.PROJECT_OVERVIEW)

    landing = resolve_landing(user)
    assert landing.intent == "project_overview"
    assert landing.path == f"/projects/{proj.pk}/overview"
    assert landing.resolved_by == "preference"


@pytest.mark.django_db
def test_unreachable_project_overview_preference_falls_through() -> None:
    """Preference points at Project Overview but the user has no project → fall through."""
    user = _user("orphan")
    _set_pref(user, DefaultLanding.PROJECT_OVERVIEW)

    landing = resolve_landing(user)
    assert landing.intent == "my_work"
    assert landing.resolved_by == "fallback"


@pytest.mark.django_db
def test_portfolio_preference_degrades_to_my_work_in_oss() -> None:
    """A downgraded-from-Enterprise user with a portfolio preference degrades cleanly."""
    user = _user("expat")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)
    _set_pref(user, DefaultLanding.PORTFOLIO)

    landing = resolve_landing(user)
    assert landing.intent == "my_work"  # OSS: portfolio never resolves
    assert landing.intent != "portfolio"


@pytest.mark.django_db
def test_default_no_profile_row_is_auto() -> None:
    """Absence of a UserProfile row reads as AUTO (no backfill required)."""
    user = _user("rowless")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)
    assert not UserProfile.objects.filter(user=user).exists()

    assert resolve_landing(user).resolved_by == "role_policy"


# ---------------------------------------------------------------------------
# Enterprise portfolio seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_portfolio_seam_resolves_when_enterprise_and_entitled(
    settings: pytest.FixtureRequest,
) -> None:
    from trueppm_api.apps.profiles import services

    settings.TRUEPPM_EDITION = "enterprise"
    services.register_portfolio_access_provider(
        access=lambda user: True,
        path=lambda user: "/portfolio",
    )
    try:
        user = _user("marcus")
        ProjectMembership.objects.create(project=_project(), user=user, role=Role.ADMIN)

        landing = resolve_landing(user)
        assert landing.intent == "portfolio"
        assert landing.path == "/portfolio"
        assert landing.resolved_by == "role_policy"
    finally:
        services._portfolio_access_provider = None
        services._portfolio_path_provider = None


@pytest.mark.django_db
def test_portfolio_seam_inert_in_community_even_if_registered(
    settings: pytest.FixtureRequest,
) -> None:
    from trueppm_api.apps.profiles import services

    settings.TRUEPPM_EDITION = "community"
    services.register_portfolio_access_provider(
        access=lambda user: True,
        path=lambda user: "/portfolio",
    )
    try:
        user = _user("marcus_oss")
        ProjectMembership.objects.create(project=_project(), user=user, role=Role.ADMIN)
        # Community edition → portfolio inert → PM falls to project_overview.
        assert resolve_landing(user).intent == "project_overview"
    finally:
        services._portfolio_access_provider = None
        services._portfolio_path_provider = None
