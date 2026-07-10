"""Milestone signal coupling (#1773).

``is_milestone``, ``delivery_mode='milestone'``, and ``duration=0`` were three
independently-writable encodings of the same fact, so a task could carry one
without the others — and different consumers keyed off different signals. These
tests lock in the canonical coupled state enforced by ``TaskSerializer.validate``
and the MSP importer, plus the structural guards that keep a milestone childless
and prevent a sprint-targeted milestone from being silently un-flagged.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    Project,
    Sprint,
    SprintState,
    Task,
)

User = get_user_model()

TASKS_URL = "/api/v1/tasks/"


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Artemis", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _task(project: Project, wbs_path: str = "1", **kwargs: object) -> Task:
    return Task.objects.create(project=project, name="T", wbs_path=wbs_path, **kwargs)


# ---------------------------------------------------------------------------
# Serializer coupling — whichever signal is sent drives the others
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_setting_is_milestone_couples_delivery_mode_and_zeros_duration(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=5)
    r = client.patch(f"{TASKS_URL}{t.pk}/", {"is_milestone": True}, format="json")
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is True
    assert t.delivery_mode == DeliveryMode.MILESTONE
    assert t.duration == 0


@pytest.mark.django_db
def test_setting_delivery_mode_milestone_couples_is_milestone_and_zeros_duration(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=5)
    r = client.patch(
        f"{TASKS_URL}{t.pk}/", {"delivery_mode": DeliveryMode.MILESTONE}, format="json"
    )
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is True
    assert t.delivery_mode == DeliveryMode.MILESTONE
    assert t.duration == 0


@pytest.mark.django_db
def test_unflagging_milestone_resets_delivery_mode_to_waterfall(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)
    r = client.patch(f"{TASKS_URL}{t.pk}/", {"is_milestone": False}, format="json")
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is False
    assert t.delivery_mode == DeliveryMode.WATERFALL


@pytest.mark.django_db
def test_conflicting_signals_are_rejected(client: APIClient, project: Project) -> None:
    t = _task(project, duration=5)
    r = client.patch(
        f"{TASKS_URL}{t.pk}/",
        {"is_milestone": True, "delivery_mode": DeliveryMode.SCRUM},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["is_milestone"][0].code == "milestone_signal_conflict"


@pytest.mark.django_db
def test_editing_duration_on_existing_milestone_is_reclamped_to_zero(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)
    r = client.patch(f"{TASKS_URL}{t.pk}/", {"duration": 7}, format="json")
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.duration == 0


# ---------------------------------------------------------------------------
# Un-flagging a sprint-targeted milestone is blocked
# ---------------------------------------------------------------------------


def _sprint_targeting(project: Project, milestone: Task) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        goal="Ship",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
        target_milestone=milestone,
    )


@pytest.mark.django_db
def test_cannot_unflag_milestone_targeted_by_live_sprint(
    client: APIClient, project: Project
) -> None:
    m = _task(project, wbs_path="9", duration=0, is_milestone=True)
    _sprint_targeting(project, m)
    r = client.patch(f"{TASKS_URL}{m.pk}/", {"is_milestone": False}, format="json")
    assert r.status_code == 400
    assert r.data["is_milestone"][0].code == "milestone_targeted_by_sprint"
    m.refresh_from_db()
    assert m.is_milestone is True


@pytest.mark.django_db
def test_unflag_via_delivery_mode_is_also_blocked_when_targeted(
    client: APIClient, project: Project
) -> None:
    # Flipping delivery_mode off 'milestone' un-milestones the task through the
    # coupling — the sprint-target guard must catch that path too.
    m = _task(project, wbs_path="9", duration=0, is_milestone=True)
    _sprint_targeting(project, m)
    r = client.patch(
        f"{TASKS_URL}{m.pk}/", {"delivery_mode": DeliveryMode.WATERFALL}, format="json"
    )
    assert r.status_code == 400
    assert r.data["is_milestone"][0].code == "milestone_targeted_by_sprint"


@pytest.mark.django_db
def test_unflag_allowed_after_sprint_unlinked(client: APIClient, project: Project) -> None:
    m = _task(project, wbs_path="9", duration=0, is_milestone=True)
    sprint = _sprint_targeting(project, m)
    sprint.target_milestone = None
    sprint.save(update_fields=["target_milestone"])
    r = client.patch(f"{TASKS_URL}{m.pk}/", {"is_milestone": False}, format="json")
    assert r.status_code == 200
    m.refresh_from_db()
    assert m.is_milestone is False


# ---------------------------------------------------------------------------
# A milestone cannot acquire children (create / indent / reparent)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cannot_create_child_under_milestone(client: APIClient, project: Project) -> None:
    m = _task(project, wbs_path="1", duration=0, is_milestone=True)
    r = client.post(
        TASKS_URL,
        {"project": str(project.pk), "name": "Child", "duration": 1, "parent_id": str(m.pk)},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["parent_id"][0].code == "child_of_milestone"


@pytest.mark.django_db
def test_cannot_indent_under_milestone(client: APIClient, project: Project) -> None:
    _task(project, wbs_path="1", duration=0, is_milestone=True)
    t2 = _task(project, wbs_path="2", duration=3)
    r = client.post(f"/api/v1/projects/{project.id}/tasks/{t2.id}/indent/")
    assert r.status_code == 400
    assert r.data["code"] == "child_of_milestone"
    t2.refresh_from_db()
    assert t2.wbs_path == "2"


@pytest.mark.django_db
def test_cannot_reparent_under_milestone(client: APIClient, project: Project) -> None:
    m = _task(project, wbs_path="1", duration=0, is_milestone=True)
    stray = _task(project, wbs_path="2", duration=5)
    r = client.post(
        f"/api/v1/projects/{project.id}/tasks/{stray.id}/reparent/",
        {"new_parent_id": str(m.id)},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "child_of_milestone"
    stray.refresh_from_db()
    assert stray.wbs_path == "2"
