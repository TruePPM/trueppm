"""A trashed project's members are not recipients (#4599).

#4577 made "a trashed project confers no role" an invariant and #4599 extended the
membership-floor gate to the project axis. Each recipient-set resolver below is asserted
live first, so a vacuous empty result cannot pass, and then again after the project is
trashed.

Covered: @-group expansion (``all``, ``admins``), user-defined group expansion
(``access.groups`` and ``notifications.services``), @user mention resolution and the
mention routing context, impediment recipients (admin cohort and Scrum Master facet),
``_sprint_lead_recipient_ids`` (admin cohort and Scrum Master facet),
``_sprint_team_recipients``, ``notify_milestone_forecast_shift``,
``notify_project_end_date_shift``, and the two ``config_notice`` resolvers
(``assigned_recipient_ids``, ``surface_recipient_ids``), plus a guard that project
soft-delete still notifies the team.

Not covered here: ``surface_recipient_ids_by_project`` on its own (it is exercised through
``surface_recipient_ids``, its one-element wrapper), the approval/baseline admin cohorts,
and the importer role helpers; those are only held by the gate's project-axis rule.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.groups import (
    resolve_group_members,
    resolve_user_defined_group_members,
)
from trueppm_api.apps.access.models import ProjectMembership, Role, UserDefinedMentionGroup
from trueppm_api.apps.notifications import services as notification_services
from trueppm_api.apps.projects import views as project_views
from trueppm_api.apps.projects.blocker_services import resolve_impediment_recipients
from trueppm_api.apps.projects.config_notice import (
    assigned_recipient_ids,
    surface_recipient_ids,
)
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, Task
from trueppm_api.apps.projects.services import (
    _sprint_lead_recipient_ids,
    notify_milestone_forecast_shift,
)
from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot
from trueppm_api.apps.scheduling.services import notify_project_end_date_shift
from trueppm_api.apps.teams.models import Team, TeamMembership

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def world() -> dict[str, object]:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=cal)
    admin = User.objects.create_user(username="pm", password="pw")
    member = User.objects.create_user(username="dev", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    task = Task.objects.create(project=project, name="T", duration=1, assignee=member)
    team = Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)
    scrum_master = User.objects.create_user(username="sm", password="pw")
    ProjectMembership.objects.create(project=project, user=scrum_master, role=Role.MEMBER)
    TeamMembership.objects.create(team=team, user=scrum_master, is_scrum_master=True)
    return {
        "project": project,
        "admin": admin,
        "member": member,
        "task": task,
        "scrum_master": scrum_master,
    }


def _trash(project: Project) -> None:
    Project.objects.filter(pk=project.pk).update(is_deleted=True)


@pytest.mark.parametrize("key", ["all", "admins"])
def test_group_expansion_skips_trashed_project(world: dict[str, object], key: str) -> None:
    project = world["project"]
    assert resolve_group_members(project.pk, key)  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    assert resolve_group_members(project.pk, key) == []  # type: ignore[attr-defined]


def test_impediment_recipients_skip_trashed_project(world: dict[str, object]) -> None:
    task = world["task"]
    assert resolve_impediment_recipients(task)  # type: ignore[arg-type]
    _trash(world["project"])  # type: ignore[arg-type]
    assert resolve_impediment_recipients(Task.objects.get(pk=task.pk)) == set()  # type: ignore[attr-defined]


def test_impediment_recipients_include_scrum_master_until_trashed(
    world: dict[str, object],
) -> None:
    """The facet arm: a default-team Scrum Master is a recipient only while the project is live."""
    task, sm = world["task"], world["scrum_master"]
    assert sm.pk in resolve_impediment_recipients(task)  # type: ignore[attr-defined]
    _trash(world["project"])  # type: ignore[arg-type]
    assert resolve_impediment_recipients(Task.objects.get(pk=task.pk)) == set()  # type: ignore[attr-defined]


def test_sprint_lead_recipients_skip_trashed_project(world: dict[str, object]) -> None:
    """Admin cohort and Scrum Master facet both drop out when the project is trashed."""
    project, admin, sm = world["project"], world["admin"], world["scrum_master"]
    live = set(_sprint_lead_recipient_ids(project.pk, None))  # type: ignore[attr-defined]
    assert {admin.pk, sm.pk} <= live  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    assert _sprint_lead_recipient_ids(project.pk, None) == []  # type: ignore[attr-defined]


def test_sprint_team_recipients_skip_trashed_project(world: dict[str, object]) -> None:
    project, member = world["project"], world["member"]
    sprint = Sprint.objects.create(
        project=project,  # type: ignore[misc]
        name="S1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
    )
    other = Task.objects.create(
        project=project,  # type: ignore[misc]
        name="In sprint",
        duration=1,
        assignee=member,  # type: ignore[misc]
        sprint=sprint,
    )
    assert _sprint_team_recipients_for(other, sprint) == [str(member.pk)]  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    assert _sprint_team_recipients_for(other, sprint) == []


def _sprint_team_recipients_for(task: Task, sprint: Sprint) -> list[str | None]:
    return project_views._sprint_team_recipients(task, sprint.pk, set())


def _captured_recipients(monkeypatch: pytest.MonkeyPatch) -> list[list[object]]:
    """Replace ``create_event_notifications`` and record each call's ``recipient_ids``."""
    calls: list[list[object]] = []

    def _record(**kwargs: object) -> None:
        calls.append(list(kwargs["recipient_ids"]))  # type: ignore[call-overload]

    monkeypatch.setattr(notification_services, "create_event_notifications", _record)
    return calls


def test_milestone_forecast_shift_skips_trashed_project(
    world: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
    django_capture_on_commit_callbacks: object,
) -> None:
    project, admin = world["project"], world["admin"]
    calls = _captured_recipients(monkeypatch)
    snapshot = SimpleNamespace(
        pk=None,
        project_id=project.pk,  # type: ignore[attr-defined]
        milestone_id=None,
        milestone=None,
        p50=date(2026, 3, 1),
        p80=date(2026, 3, 8),
        confidence="medium",
    )
    sprint = SimpleNamespace(name="S1")
    with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
        notify_milestone_forecast_shift(snapshot, sprint)
    assert calls == [[admin.pk]]  # type: ignore[attr-defined]

    calls.clear()
    _trash(project)  # type: ignore[arg-type]
    with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
        notify_milestone_forecast_shift(snapshot, sprint)
    assert calls == []


def test_project_end_date_shift_skips_trashed_project(
    world: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
    django_capture_on_commit_callbacks: object,
) -> None:
    project, admin = world["project"], world["admin"]
    calls = _captured_recipients(monkeypatch)
    ProjectForecastSnapshot.objects.create(
        project=project,  # type: ignore[misc]
        cpm_finish=date(2026, 3, 2),
        cpm_finish_at_day_start=False,
    )
    snapshot = ProjectForecastSnapshot.objects.create(
        project=project,  # type: ignore[misc]
        cpm_finish=date(2026, 6, 1),
        cpm_finish_at_day_start=False,
    )
    with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
        notify_project_end_date_shift(snapshot)
    assert calls == [[admin.pk]]  # type: ignore[attr-defined]

    calls.clear()
    _trash(project)  # type: ignore[arg-type]
    with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
        notify_project_end_date_shift(snapshot)
    assert calls == []


def test_config_notice_resolvers_skip_trashed_project(world: dict[str, object]) -> None:
    project, member, admin = world["project"], world["member"], world["admin"]
    assert assigned_recipient_ids(project.pk) == [member.pk]  # type: ignore[attr-defined]
    assert admin.pk in surface_recipient_ids(project.pk)  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    assert assigned_recipient_ids(project.pk) == []  # type: ignore[attr-defined]
    assert surface_recipient_ids(project.pk) == []  # type: ignore[attr-defined]


def test_user_defined_group_expansion_skips_trashed_project(world: dict[str, object]) -> None:
    """Both resolvers: the ``access.groups`` one and the notification-side loader."""
    project, member = world["project"], world["member"]
    group = UserDefinedMentionGroup.objects.create(project=project, name="devs")  # type: ignore[misc]
    group.members.add(member)  # type: ignore[arg-type]
    assert resolve_user_defined_group_members(project.pk, "devs") == [member.pk]  # type: ignore[attr-defined]
    loaded = notification_services._load_project_udg_members(project.pk, ["devs"])  # type: ignore[attr-defined]
    assert [u.pk for u in loaded["devs"]] == [member.pk]  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    assert resolve_user_defined_group_members(project.pk, "devs") == []  # type: ignore[attr-defined]
    loaded = notification_services._load_project_udg_members(project.pk, ["devs"])  # type: ignore[attr-defined]
    assert loaded.get("devs", []) == []


def test_user_mention_resolution_skips_trashed_project(world: dict[str, object]) -> None:
    project = world["project"]
    parsed = [notification_services.ParsedMention(kind="user", value="dev")]
    users, _groups, skipped = notification_services._resolve_user_mentions(parsed, project.pk)  # type: ignore[attr-defined]
    assert [u.username for u in users] == ["dev"] and skipped == []
    _trash(project)  # type: ignore[arg-type]
    users, _groups, skipped = notification_services._resolve_user_mentions(parsed, project.pk)  # type: ignore[attr-defined]
    assert users == [] and skipped == ["dev"]


def test_mention_routing_context_drops_trashed_project_members(world: dict[str, object]) -> None:
    """The email boundary: a non-member of a live source project gets no email."""
    project, member = world["project"], world["member"]
    ctx = notification_services._load_mention_routing_context(project.pk, [member.pk])  # type: ignore[attr-defined]
    assert member.pk in ctx.source_project_member_ids  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    ctx = notification_services._load_mention_routing_context(project.pk, [member.pk])  # type: ignore[attr-defined]
    assert ctx.source_project_member_ids == set()


def test_project_soft_delete_still_notifies_the_team(
    world: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
    django_capture_on_commit_callbacks: object,
) -> None:
    """The "Project was deleted" notice reaches the team after a soft delete.

    ``perform_destroy`` floors its membership read on ``project__is_deleted=False`` (#4599),
    so that read must run while the project is still live. If it moved below
    ``soft_delete_project`` it would return nothing and the notice would drop silently.
    """
    project, admin, member = world["project"], world["admin"], world["member"]
    owner = User.objects.create_user(username="owner", password="pw")
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)  # type: ignore[misc]
    sent: list[tuple[str, list[object]]] = []
    monkeypatch.setattr(
        project_views,
        "_notify_event",
        lambda event, recipients, *a, **k: sent.append((event, list(recipients))),
    )
    client = APIClient()
    client.force_authenticate(owner)
    with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
        resp = client.delete(f"/api/v1/projects/{project.pk}/")  # type: ignore[attr-defined]
    assert resp.status_code == 204
    assert len(sent) == 1 and sent[0][0] == "project.deleted"
    assert {str(admin.pk), str(member.pk)} <= set(sent[0][1])  # type: ignore[attr-defined]
    assert str(owner.pk) not in sent[0][1]
