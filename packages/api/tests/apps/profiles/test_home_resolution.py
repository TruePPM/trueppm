"""Tests for the shell-v2 home resolver (ADR-1298 amendment, #4755).

One test per precedence branch of ``resolve_home``, the ``home_program`` cases,
the ``/auth/me/`` wire shape, and a lock that the v1 ``intent``/``path`` are
unchanged by the added keys.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.models import DefaultLanding, ProjectVisit, UserProfile
from trueppm_api.apps.profiles.services import resolve_home, resolve_landing
from trueppm_api.apps.projects.models import Calendar, Program, Project, Task, TaskStatus

User = get_user_model()


def _project(name: str = "P1", program: Program | None = None) -> Project:
    cal = Calendar.objects.create(name=f"Cal-{name}")
    return Project.objects.create(
        name=name, start_date=date(2026, 1, 1), calendar=cal, program=program
    )


def _user(username: str) -> User:
    return User.objects.create_user(username=username, password="pw")


def _home(user: User) -> str:
    return resolve_home(user, resolve_landing(user)).home


def _profile(user: User, **fields: object) -> None:
    UserProfile.objects.update_or_create(user=user, defaults=fields)


# ---------------------------------------------------------------------------
# Precedence
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_home_override_rm_wins_over_everything() -> None:
    user = _user("rita")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.OWNER)
    _profile(user, default_landing=DefaultLanding.MY_WORK, home_override="rm")
    assert _home(user) == "rm"


@pytest.mark.django_db
def test_preference_my_work_maps_to_contributor_even_for_an_owner() -> None:
    user = _user("olga")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.OWNER)
    _profile(user, default_landing=DefaultLanding.MY_WORK)
    assert _home(user) == "contributor"


@pytest.mark.django_db
def test_preference_project_overview_maps_to_pm_for_a_viewer() -> None:
    user = _user("vera")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.VIEWER)
    _profile(user, default_landing=DefaultLanding.PROJECT_OVERVIEW)
    assert _home(user) == "pm"


@pytest.mark.django_db
def test_oss_portfolio_preference_falls_through_to_role_policy() -> None:
    """In OSS ``_landing_from_preference`` does not honor portfolio, so neither
    does the home: a Member with a stored portfolio is a contributor."""
    user = _user("pat")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)
    _profile(user, default_landing=DefaultLanding.PORTFOLIO)
    assert _home(user) == "contributor"


@pytest.mark.django_db
def test_enterprise_portfolio_preference_maps_to_exec(settings: pytest.FixtureRequest) -> None:
    """Enterprise + entitled: an honored portfolio preference is the exec home,
    even for a Member the role policy would make a contributor."""
    from trueppm_api.apps.profiles import services

    settings.TRUEPPM_EDITION = "enterprise"
    services.register_portfolio_access_provider(
        access=lambda user: True,
        path=lambda user: "/portfolio",
    )
    try:
        user = _user("pmo-pref")
        ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)
        _profile(user, default_landing=DefaultLanding.PORTFOLIO)
        landing = resolve_landing(user)
        assert (landing.intent, landing.resolved_by) == ("portfolio", "preference")
        assert resolve_home(user, landing).home == "exec"
    finally:
        services._portfolio_access_provider = None
        services._portfolio_path_provider = None


@pytest.mark.django_db
def test_demo_visitor_home_is_pm(settings: pytest.FixtureRequest) -> None:
    from trueppm_api.apps.projects.seed.demo_landing_overlay import LANDING_PROJECT_NAME

    settings.DEMO_READ_ONLY = True
    settings.DEMO_LOGIN_HINT = {"username": "atlas-visitor", "password": "x"}
    user = _user("atlas-visitor")
    proj = _project(LANDING_PROJECT_NAME)
    ProjectMembership.objects.create(project=proj, user=user, role=Role.MEMBER)
    assert _home(user) == "pm"


@pytest.mark.django_db
def test_no_memberships_is_contributor() -> None:
    assert _home(_user("newbie")) == "contributor"


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.OWNER, Role.ADMIN, Role.SCHEDULER])
def test_scheduler_and_above_is_pm(role: int) -> None:
    user = _user(f"lead{role}")
    ProjectMembership.objects.create(project=_project(), user=user, role=role)
    assert _home(user) == "pm"


@pytest.mark.django_db
def test_program_scheduler_with_no_recent_project_is_still_pm() -> None:
    """``path`` falls back to My Work, but the home stays pm."""
    user = _user("progsched")
    ProgramMembership.objects.create(
        program=Program.objects.create(name="Apollo"), user=user, role=Role.SCHEDULER
    )
    landing = resolve_landing(user)
    assert landing.path == "/me/work"
    assert resolve_home(user, landing).home == "pm"


@pytest.mark.django_db
def test_program_role_outranks_a_lower_project_role() -> None:
    user = _user("mixed")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(
        program=Program.objects.create(name="Borealis"), user=user, role=Role.ADMIN
    )
    assert _home(user) == "pm"


@pytest.mark.django_db
def test_member_is_contributor() -> None:
    user = _user("mem")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)
    assert _home(user) == "contributor"


@pytest.mark.django_db
def test_viewer_with_an_assignment_is_contributor() -> None:
    user = _user("viewer-assigned")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.VIEWER)
    Task.objects.create(project=proj, name="Mine", duration=1, assignee=user)
    assert _home(user) == "contributor"


@pytest.mark.django_db
def test_viewer_with_only_a_task_resource_assignment_is_contributor() -> None:
    """/me/work also lists TaskResource rows on the user's linked Resource, so a
    Viewer with no ``assignee`` row but a resource assignment is a contributor."""
    from trueppm_api.apps.resources.models import Resource, TaskResource

    user = _user("viewer-resourced")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.VIEWER)
    task = Task.objects.create(project=proj, name="Via resource", duration=1)
    resource = Resource.objects.create(name="Viewer R", user=user)
    TaskResource.objects.create(task=task, resource=resource)
    assert _home(user) == "contributor"


@pytest.mark.django_db
def test_viewer_whose_only_assignment_is_backlog_or_deleted_is_exec() -> None:
    """The assignment source is /me/work's: BACKLOG and soft-deleted rows do not count."""
    user = _user("viewer-backlog")
    proj = _project()
    ProjectMembership.objects.create(project=proj, user=user, role=Role.VIEWER)
    Task.objects.create(
        project=proj, name="Later", duration=1, assignee=user, status=TaskStatus.BACKLOG
    )
    Task.objects.create(project=proj, name="Gone", duration=1, assignee=user, is_deleted=True)
    assert _home(user) == "exec"


@pytest.mark.django_db
def test_viewer_only_with_no_assignments_is_exec() -> None:
    user = _user("sponsor")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.VIEWER)
    assert _home(user) == "exec"


@pytest.mark.django_db
def test_resolver_fails_open_to_contributor(monkeypatch: pytest.MonkeyPatch) -> None:
    from trueppm_api.apps.profiles import services

    def boom(*_a: object, **_k: object) -> str:
        raise RuntimeError("boom")

    monkeypatch.setattr(services, "_resolve_home", boom)
    user = _user("boom")
    home = resolve_home(user, resolve_landing(user))
    assert home.home == "contributor"
    assert home.program is None


# ---------------------------------------------------------------------------
# home_program
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_home_program_is_the_recent_projects_program_when_a_member() -> None:
    zulu = Program.objects.create(name="Zulu", code="ZU")
    alpha = Program.objects.create(name="Alpha", code="AL")
    user = _user("exec-recent")
    proj = _project("InZulu", program=zulu)
    ProjectMembership.objects.create(project=proj, user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(program=zulu, user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(program=alpha, user=user, role=Role.VIEWER)
    ProjectVisit.objects.create(
        user=user, project=proj, visited_at=datetime(2026, 5, 1, tzinfo=UTC)
    )

    home = resolve_home(user, resolve_landing(user))
    assert home.home == "exec"
    assert home.program == {"id": str(zulu.pk), "code": "ZU", "name": "Zulu"}


@pytest.mark.django_db
def test_home_program_skips_the_recent_projects_program_without_membership() -> None:
    """The program rollup is members-only: a project Viewer inside a program they
    do not belong to must not be sent there. Falls through to their own program."""
    zulu = Program.objects.create(name="Zulu", code="ZU")
    alpha = Program.objects.create(name="Alpha", code="AL")
    user = _user("exec-outsider")
    proj = _project("InZulu", program=zulu)
    ProjectMembership.objects.create(project=proj, user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(program=alpha, user=user, role=Role.VIEWER)
    ProjectVisit.objects.create(
        user=user, project=proj, visited_at=datetime(2026, 5, 1, tzinfo=UTC)
    )

    home = resolve_home(user, resolve_landing(user))
    assert home.home == "exec"
    assert home.program == {"id": str(alpha.pk), "code": "AL", "name": "Alpha"}


@pytest.mark.django_db
def test_home_program_is_null_when_the_only_program_is_not_the_users() -> None:
    zulu = Program.objects.create(name="Zulu", code="ZU")
    user = _user("exec-no-program")
    proj = _project("InZulu", program=zulu)
    ProjectMembership.objects.create(project=proj, user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(program=zulu, user=user, role=Role.VIEWER, is_deleted=True)
    home = resolve_home(user, resolve_landing(user))
    assert home.home == "exec"
    assert home.program is None


@pytest.mark.django_db
def test_home_program_falls_back_to_first_program_by_name() -> None:
    """Recent project has no program → first program membership by name; a
    program-only Viewer (no recent project at all) takes the same branch."""
    beta = Program.objects.create(name="Beta", code="BE")
    alpha = Program.objects.create(name="Alpha", code="AL")
    user = _user("exec-fallback")
    ProjectMembership.objects.create(project=_project("Loose"), user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(program=beta, user=user, role=Role.VIEWER)
    ProgramMembership.objects.create(program=alpha, user=user, role=Role.VIEWER)
    assert resolve_home(user, resolve_landing(user)).program == {
        "id": str(alpha.pk),
        "code": "AL",
        "name": "Alpha",
    }

    program_only = _user("exec-program-only")
    ProgramMembership.objects.create(program=beta, user=program_only, role=Role.VIEWER)
    home = resolve_home(program_only, resolve_landing(program_only))
    assert home.home == "exec"
    assert home.program is not None and home.program["name"] == "Beta"


@pytest.mark.django_db
def test_home_program_is_null_without_program_memberships() -> None:
    user = _user("exec-none")
    ProjectMembership.objects.create(project=_project("Solo"), user=user, role=Role.VIEWER)
    home = resolve_home(user, resolve_landing(user))
    assert home.home == "exec"
    assert home.program is None


@pytest.mark.django_db
def test_home_program_is_null_for_non_exec_homes() -> None:
    user = _user("pm-with-program")
    program = Program.objects.create(name="Gamma", code="GA")
    ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
    assert resolve_home(user, resolve_landing(user)).program is None


# ---------------------------------------------------------------------------
# /auth/me/ wire shape — v1 keys unchanged
# ---------------------------------------------------------------------------


def _me_landing(user: User) -> dict[str, object]:
    c = APIClient()
    c.force_authenticate(user=user)
    resp = c.get("/api/v1/auth/me/")
    assert resp.status_code == 200
    return dict(resp.data["landing"])


@pytest.mark.django_db
def test_me_landing_carries_home_and_keeps_v1_keys(settings: pytest.FixtureRequest) -> None:
    """For a fixture of each existing v1 branch, ``intent``/``path``/``resolved_by``
    are exactly what ``resolve_landing`` returns; the home keys are additive."""
    from trueppm_api.apps.projects.seed.demo_landing_overlay import LANDING_PROJECT_NAME

    settings.DEMO_READ_ONLY = True
    settings.DEMO_LOGIN_HINT = {"username": "atlas-visitor", "password": "x"}

    pref_user = _user("v1-pref")
    pref_proj = _project("PrefProj")
    ProjectMembership.objects.create(project=pref_proj, user=pref_user, role=Role.MEMBER)
    _profile(pref_user, default_landing=DefaultLanding.PROJECT_OVERVIEW)

    demo_user = _user("atlas-visitor")
    ProjectMembership.objects.create(
        project=_project(LANDING_PROJECT_NAME), user=demo_user, role=Role.MEMBER
    )

    nobody = _user("v1-nobody")

    pm_user = _user("v1-pm")
    ProjectMembership.objects.create(project=_project("PmProj"), user=pm_user, role=Role.SCHEDULER)

    member = _user("v1-member")
    ProjectMembership.objects.create(project=_project("MemProj"), user=member, role=Role.MEMBER)

    my_work_pref = _user("v1-mywork-pref")
    ProjectMembership.objects.create(
        project=_project("OwnProj"), user=my_work_pref, role=Role.OWNER
    )
    _profile(my_work_pref, default_landing=DefaultLanding.MY_WORK)

    viewer = _user("v1-viewer")
    ProjectMembership.objects.create(project=_project("ViewProj"), user=viewer, role=Role.VIEWER)

    expected_home = {
        pref_user: "pm",
        demo_user: "pm",
        nobody: "contributor",
        pm_user: "pm",
        member: "contributor",
        my_work_pref: "contributor",
        viewer: "exec",
    }
    for user, home in expected_home.items():
        v1 = resolve_landing(user)
        wire = _me_landing(user)
        assert wire["intent"] == v1.intent
        assert wire["path"] == v1.path
        assert wire["resolved_by"] == v1.resolved_by
        assert wire["home"] == home
        assert wire["home_program"] is None


@pytest.mark.django_db
def test_home_override_does_not_move_the_v1_front_door() -> None:
    user = _user("rm-v1")
    ProjectMembership.objects.create(project=_project(), user=user, role=Role.MEMBER)
    before = resolve_landing(user)
    _profile(user, home_override="rm")
    wire = _me_landing(user)
    assert (wire["intent"], wire["path"], wire["resolved_by"]) == (
        before.intent,
        before.path,
        before.resolved_by,
    )
    assert wire["home"] == "rm"
