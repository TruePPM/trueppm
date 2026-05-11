"""Tests for short hex object IDs (ADR-0016, issue #50)."""

from __future__ import annotations

import uuid
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username=f"pm-{uuid.uuid4().hex[:8]}", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Model — short_id assignment
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_gets_short_id_on_create(project: Project) -> None:
    t = Task.objects.create(project=project, name="T1", duration=3)
    assert t.short_id == "00000001"


@pytest.mark.django_db
def test_risk_gets_short_id_on_create(project: Project, user: object) -> None:
    r = Risk.objects.create(project=project, title="R1", probability=3, impact=4, created_by=user)
    assert r.short_id == "00000001"


@pytest.mark.django_db
def test_short_ids_are_sequential_across_types(project: Project, user: object) -> None:
    """Tasks and risks share the same counter per project."""
    t1 = Task.objects.create(project=project, name="T1", duration=1)
    r1 = Risk.objects.create(project=project, title="R1", probability=1, impact=1, created_by=user)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    assert t1.short_id == "00000001"
    assert r1.short_id == "00000002"
    assert t2.short_id == "00000003"


@pytest.mark.django_db
def test_short_ids_are_project_scoped(calendar: Calendar) -> None:
    """Two projects have independent counters."""
    p1 = Project.objects.create(name="P1", start_date=date(2026, 1, 1), calendar=calendar)
    p2 = Project.objects.create(name="P2", start_date=date(2026, 1, 1), calendar=calendar)
    t1 = Task.objects.create(project=p1, name="A", duration=1)
    t2 = Task.objects.create(project=p2, name="B", duration=1)
    assert t1.short_id == t2.short_id == "00000001"


@pytest.mark.django_db
def test_short_id_immutable_on_update(project: Project) -> None:
    """short_id does not change when the task is updated."""
    t = Task.objects.create(project=project, name="T1", duration=1)
    original = t.short_id
    t.name = "Updated"
    t.save()
    t.refresh_from_db()
    assert t.short_id == original


@pytest.mark.django_db
def test_project_object_sequence_tracks_counter(project: Project) -> None:
    Task.objects.create(project=project, name="T1", duration=1)
    Task.objects.create(project=project, name="T2", duration=1)
    project.refresh_from_db()
    assert project.object_sequence == 2


# ---------------------------------------------------------------------------
# API — TaskSerializer includes short_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_short_id(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        t = Task.objects.create(project=project, name="T1", duration=1)
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(item for item in results if item["id"] == str(t.pk))
    assert first["short_id"] == "00000001"


@pytest.mark.django_db
def test_short_id_is_read_only_on_patch(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    t = Task.objects.create(project=project, name="T1", duration=1)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{t.pk}/",
            {"short_id": "FFFFFFFF"},
            format="json",
        )
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.short_id == "00000001"  # unchanged


@pytest.mark.django_db
def test_task_filter_by_short_id(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    Task.objects.create(project=project, name="T1", duration=1)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    r = client.get(f"/api/v1/tasks/?project={project.pk}&short_id=00000002")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    assert len(results) == 1
    assert results[0]["id"] == str(t2.pk)


@pytest.mark.django_db
def test_task_filter_short_id_case_insensitive(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Filter should match regardless of case."""
    Task.objects.create(project=project, name="T1", duration=1)
    r = client.get(f"/api/v1/tasks/?project={project.pk}&short_id=00000001")
    results = r.data.get("results", r.data)
    assert len(results) == 1
    # Also try lowercase
    r2 = client.get(f"/api/v1/tasks/?project={project.pk}&short_id=00000001")
    results2 = r2.data.get("results", r2.data)
    assert len(results2) == 1


# ---------------------------------------------------------------------------
# API — RiskSerializer includes short_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_risk_list_includes_short_id(
    client: APIClient, project: Project, user: object, membership: ProjectMembership
) -> None:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        risk = Risk.objects.create(
            project=project, title="R1", probability=2, impact=3, created_by=user
        )
    r = client.get(f"/api/v1/projects/{project.pk}/risks/")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(item for item in results if item["id"] == str(risk.pk))
    assert first["short_id"] == "00000001"


@pytest.mark.django_db
def test_risk_short_id_is_read_only(
    client: APIClient, project: Project, user: object, membership: ProjectMembership
) -> None:
    risk = Risk.objects.create(
        project=project, title="R1", probability=2, impact=3, created_by=user
    )
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        r = client.patch(
            f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
            {"short_id": "FFFFFFFF"},
            format="json",
        )
    assert r.status_code == 200
    risk.refresh_from_db()
    assert risk.short_id == "00000001"


# ---------------------------------------------------------------------------
# Sync serializers include short_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_task_serializer_includes_short_id(project: Project) -> None:
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    t = Task.objects.create(project=project, name="T1", duration=1)
    data = SyncTaskSerializer(t).data
    assert data["short_id"] == "00000001"


@pytest.mark.django_db
def test_sync_risk_serializer_includes_short_id(project: Project, user: object) -> None:
    from trueppm_api.apps.sync.serializers import SyncRiskSerializer

    r = Risk.objects.create(project=project, title="R1", probability=2, impact=3, created_by=user)
    data = SyncRiskSerializer(r).data
    assert data["short_id"] == "00000001"
