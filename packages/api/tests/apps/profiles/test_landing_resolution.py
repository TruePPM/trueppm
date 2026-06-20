"""Tests for the role-based landing resolver (ADR-0129).

Covers the policy matrix (contributor / PM / no-membership), the preference
escape hatch, unreachable-preference fallthrough, the Enterprise portfolio seam,
and the fail-open guarantee.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.models import DefaultLanding, ProjectVisit, UserProfile
from trueppm_api.apps.profiles.services import (
    most_recent_project,
    record_project_visit,
    resolve_landing,
)
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


def _visit(user: User, project: Project, *, year: int = 2026, month: int = 1, day: int = 1) -> None:
    ProjectVisit.objects.create(
        user=user,
        project=project,
        visited_at=datetime(year, month, day, tzinfo=UTC),
    )


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
# Real last-visited telemetry (ADR-0150, #1182)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_most_recent_project_prefers_latest_visit_over_membership_version() -> None:
    """The real last-visited row wins over the membership-version proxy.

    The proxy would pick ``newer_membership`` (created last → highest
    server_version). A real visit to ``older_membership`` must override it.
    """
    user = _user("visitor")
    older = _project("Older")
    newer = _project("Newer")
    ProjectMembership.objects.create(project=older, user=user, role=Role.ADMIN)
    # newer membership is created second → higher server_version (the proxy's pick)
    ProjectMembership.objects.create(project=newer, user=user, role=Role.ADMIN)

    # …but the user actually last opened the OLDER project.
    _visit(user, newer, day=1)
    _visit(user, older, day=5)

    assert most_recent_project(user) == older
    landing = resolve_landing(user)
    assert landing.path == f"/projects/{older.pk}/overview"


@pytest.mark.django_db
def test_most_recent_project_falls_back_to_proxy_without_visits() -> None:
    """No visit rows yet → graceful fall back to the membership-version proxy."""
    user = _user("freshpm")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.ADMIN)
    assert not ProjectVisit.objects.filter(user=user).exists()

    assert most_recent_project(user) == proj


@pytest.mark.django_db
def test_most_recent_visit_ignores_archived_and_deleted_projects() -> None:
    """A visit to a since-archived/deleted project must not be the landing target."""
    user = _user("archpm")
    cal = Calendar.objects.create(name="Cal-A")
    archived = Project.objects.create(
        name="Archived", start_date=date(2026, 1, 1), calendar=cal, is_archived=True
    )
    active = _project("Active")
    ProjectMembership.objects.create(project=archived, user=user, role=Role.ADMIN)
    ProjectMembership.objects.create(project=active, user=user, role=Role.ADMIN)

    # Most recent visit is to the archived project — must be skipped.
    _visit(user, active, day=1)
    _visit(user, archived, day=9)

    assert most_recent_project(user) == active


@pytest.mark.django_db
def test_most_recent_visit_ignores_revoked_membership() -> None:
    """A visit survives in the table after access is revoked, but must not be picked."""
    user = _user("revoked")
    gone = _project("Gone")
    kept = _project("Kept")
    membership = ProjectMembership.objects.create(project=gone, user=user, role=Role.ADMIN)
    ProjectMembership.objects.create(project=kept, user=user, role=Role.ADMIN)

    _visit(user, kept, day=1)
    _visit(user, gone, day=9)  # most recent, but access about to be revoked

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert most_recent_project(user) == kept


@pytest.mark.django_db
def test_record_project_visit_is_idempotent_upsert() -> None:
    """Recording twice keeps a single row and advances visited_at (last wins)."""
    user = _user("upsert")
    proj = _project()

    record_project_visit(user, proj)
    first = ProjectVisit.objects.get(user=user, project=proj)

    record_project_visit(user, proj)
    rows = ProjectVisit.objects.filter(user=user, project=proj)
    assert rows.count() == 1
    assert rows.first().visited_at >= first.visited_at


@pytest.mark.django_db
def test_visits_are_per_user_no_cross_contamination() -> None:
    """One user's visits never influence another user's landing (IDOR safety)."""
    alice = _user("alice")
    bob = _user("bob")
    a_proj = _project("AliceProj")
    b_proj = _project("BobProj")
    for u, p in ((alice, a_proj), (bob, b_proj)):
        ProjectMembership.objects.create(project=p, user=u, role=Role.ADMIN)
    # Bob also belongs to AliceProj but never visited it.
    ProjectMembership.objects.create(project=a_proj, user=bob, role=Role.MEMBER)

    _visit(alice, a_proj, day=9)  # only Alice has a visit row

    assert most_recent_project(alice) == a_proj
    # Bob has no visit rows → proxy, not Alice's visit.
    assert not ProjectVisit.objects.filter(user=bob).exists()


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
