"""Time-logging against a phase is rejected (ADR-0293, #1753).

A phase rolls up the logged time of its child tasks, so a direct entry against the
phase itself would double-count. Enforced in ``TimeEntrySerializer.validate`` (manual
POST and author PATCH) and at the timer-start view (so the timer-stop path can never
bypass it). A leaf — including a leaf-with-subtasks — accepts time as before.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P1", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, alice: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER)


@pytest.fixture
def client(alice: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=alice)
    return c


def _entries_url(task: Task) -> str:
    return f"/api/v1/tasks/{task.pk}/time-entries/"


@pytest.mark.django_db
def test_log_time_against_leaf_ok(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    leaf = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1")
    r = client.post(_entries_url(leaf), {"minutes": 30}, format="json")
    assert r.status_code == 201


@pytest.mark.django_db
def test_log_time_against_phase_rejected(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    phase = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
    Task.objects.create(project=project, name="Work", duration=5, wbs_path="1.1")
    r = client.post(_entries_url(phase), {"minutes": 30}, format="json")
    assert r.status_code == 400
    # Non-field error carries the stable code.
    detail = r.data["non_field_errors"][0] if "non_field_errors" in r.data else r.data[0]
    assert detail.code == "time_log_on_phase"


@pytest.mark.django_db
def test_log_time_against_leaf_with_subtasks_ok(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """A leaf-with-subtasks is is_summary=True but NOT a phase — time still logs."""
    leaf = Task.objects.create(project=project, name="Leaf", duration=5, wbs_path="1")
    Task.objects.create(
        project=project, name="Subtask", duration=1, wbs_path="1.1", is_subtask=True
    )
    r = client.post(_entries_url(leaf), {"minutes": 45}, format="json")
    assert r.status_code == 201


@pytest.mark.django_db
def test_start_timer_on_phase_rejected(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """The timer-start path is guarded too, so timer-stop can't bypass the lock."""
    phase = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
    Task.objects.create(project=project, name="Work", duration=5, wbs_path="1.1")
    r = client.post("/api/v1/me/timer/start", {"task": str(phase.pk)}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_start_timer_on_leaf_ok(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    leaf = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1")
    r = client.post("/api/v1/me/timer/start", {"task": str(leaf.pk)}, format="json")
    assert r.status_code == 201
