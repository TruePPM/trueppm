"""The remaining surfaces through which a trashed project still acted (#4577).

Each case trashes the project row only — children, memberships, timers and open
sockets all survive that, exactly as they do before the async cascade lands — and
checks one surface that is not a viewset queryset:

* the running-timer write path, which re-derives the role without a request;
* the two 409 reference describers, which name blockers the caller can see;
* already-open WebSockets, which were checked only at connect.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from asgiref.sync import async_to_sync
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="side-member", password="pw")


@pytest.fixture
def project(calendar: Calendar, member: Any) -> Project:
    p = Project.objects.create(
        name="Side Channel", code="SIDE", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=member, role=Role.ADMIN)
    return p


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Secret task name", duration=1)


def _trash(project: Project) -> None:
    Project.objects.filter(pk=project.pk).update(is_deleted=True)


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Running timer
# ---------------------------------------------------------------------------


def _running_timer(member: Any, task: Task) -> None:
    from trueppm_api.apps.timetracking.models import ActiveTimer

    ActiveTimer.objects.create(
        user=member, task=task, started_at=timezone.now() - timedelta(minutes=5)
    )


def test_stopping_a_timer_on_a_live_project_logs_an_entry(member: Any, task: Task) -> None:
    """Control: the same timer, project live, finalizes into a TimeEntry."""
    from trueppm_api.apps.timetracking.models import TimeEntry

    _running_timer(member, task)
    resp = _client(member).post("/api/v1/me/timer/stop")
    assert resp.status_code == 201, resp.content
    assert TimeEntry.objects.filter(task=task, user=member).count() == 1


def test_stopping_a_timer_on_a_trashed_project_logs_nothing(
    member: Any, project: Project, task: Task
) -> None:
    from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry

    _running_timer(member, task)
    _trash(project)
    resp = _client(member).post("/api/v1/me/timer/stop")
    assert resp.status_code == 409, resp.content
    assert not TimeEntry.objects.filter(task=task).exists()
    assert not ActiveTimer.objects.filter(user=member).exists()


def test_a_second_start_discards_a_timer_left_on_a_trashed_project(
    member: Any, project: Project, task: Task, calendar: Calendar
) -> None:
    from trueppm_api.apps.timetracking.models import TimeEntry

    other = Project.objects.create(
        name="Other", code="OTHR", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=other, user=member, role=Role.MEMBER)
    other_task = Task.objects.create(project=other, name="Elsewhere", duration=1)

    _running_timer(member, task)
    _trash(project)
    resp = _client(member).post(
        "/api/v1/me/timer/start", {"task": str(other_task.pk)}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["finalized_entry"] is None
    assert not TimeEntry.objects.filter(task=task).exists()


# ---------------------------------------------------------------------------
# 409 reference describers
# ---------------------------------------------------------------------------


def test_calendar_describer_withholds_a_trashed_projects_name(
    member: Any, project: Project
) -> None:
    from trueppm_api.apps.projects.views import _calendar_reference_describer

    assert _calendar_reference_describer(member)(project).get("name") == project.name  # control
    _trash(project)
    project.refresh_from_db()
    entry = _calendar_reference_describer(member)(project)
    assert entry == {"type": "project", "id": str(project.pk)}


def test_skill_describer_withholds_a_trashed_projects_task_name(
    member: Any, project: Project, task: Task
) -> None:
    from trueppm_api.apps.resources.models import Skill, TaskSkillRequirement
    from trueppm_api.apps.resources.views import _skill_reference_describer

    skill = Skill.objects.create(name="Rust", normalized_name="rust", category="tech")
    requirement = TaskSkillRequirement.objects.create(task=task, skill=skill)

    assert _skill_reference_describer(member)(requirement).get("name") == task.name  # control
    _trash(project)
    requirement.refresh_from_db()
    entry = _skill_reference_describer(member)(requirement)
    assert entry == {"type": "task", "id": str(task.pk)}


# ---------------------------------------------------------------------------
# Open WebSockets
# ---------------------------------------------------------------------------


def test_group_evict_closes_every_socket_whatever_its_user(member: Any) -> None:
    from trueppm_api.apps.sync.consumers import WS_CLOSE_FORBIDDEN, ProjectConsumer

    consumer = ProjectConsumer()
    consumer._user = member
    consumer.close = AsyncMock()  # type: ignore[method-assign]
    async_to_sync(consumer.connection_evict)({"type": "connection.evict", "all": True})
    consumer.close.assert_awaited_once_with(code=WS_CLOSE_FORBIDDEN)


def test_per_user_evict_still_ignores_other_users(member: Any) -> None:
    """Control: the pre-existing per-user evict is unchanged by the ``all`` arm."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer._user = member
    consumer.close = AsyncMock()  # type: ignore[method-assign]
    async_to_sync(consumer.connection_evict)({"type": "connection.evict", "user_id": "someone"})
    consumer.close.assert_not_awaited()


@pytest.mark.django_db(transaction=True)
def test_trashing_a_project_evicts_its_group_after_announcing_the_delete(
    member: Any, project: Project
) -> None:
    """``soft_delete_project`` sends ``project_deleted`` and THEN the group evict.

    Order matters: a channel group delivers in send order, so clients learn the
    project is gone before their socket closes.
    """
    from trueppm_api.apps.projects.services import soft_delete_project

    calls: list[str] = []
    with (
        patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            side_effect=lambda pid, event, payload: calls.append(f"broadcast:{event}:{pid}"),
        ),
        patch(
            "trueppm_api.apps.sync.broadcast.evict_project_group",
            side_effect=lambda pid: calls.append(f"evict:{pid}"),
        ),
        patch("trueppm_api.apps.projects.services.enqueue_project_cascade_soft_delete"),
    ):
        soft_delete_project(project, actor=member)

    pid = str(project.pk)
    assert calls == [f"broadcast:project_deleted:{pid}", f"evict:{pid}"]
