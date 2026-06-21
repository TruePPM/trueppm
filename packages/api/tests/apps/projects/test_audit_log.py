"""Audit-log emission for project lifecycle events (#859, ADR-0157).

The project create/delete sites live in the projects app but write workspace
operational audit rows via ``workspace.services.record_audit_event`` (function-
level import, projects → workspace). The remaining six emission sites are covered
in ``tests/apps/workspace/test_audit_log.py``.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.workspace.models import AuditEvent, AuditEventType

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="creator", password="pw", email="c@x.io")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.mark.django_db
def test_project_create_logs_event(client: APIClient, calendar: Calendar, user: object) -> None:
    resp = client.post(
        "/api/v1/projects/",
        {"name": "Beta", "start_date": "2026-04-01", "calendar": str(calendar.pk)},
    )
    assert resp.status_code == 201
    event = AuditEvent.objects.get(event_type=AuditEventType.PROJECT_CREATED)
    assert event.actor_id == user.pk
    assert event.target_type == "project"
    assert str(event.target_id) == resp.data["id"]
    assert event.target_label == "Beta"


@pytest.mark.django_db
def test_project_soft_delete_logs_event(
    client: APIClient, calendar: Calendar, user: object
) -> None:
    project = Project.objects.create(name="Gamma", start_date=date(2026, 3, 2), calendar=calendar)
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)

    resp = client.delete(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 204
    event = AuditEvent.objects.get(event_type=AuditEventType.PROJECT_DELETED)
    assert event.actor_id == user.pk
    assert str(event.target_id) == str(project.pk)
    assert event.target_label == "Gamma"
    assert event.metadata == {"mode": "soft"}


@pytest.mark.django_db
def test_project_hard_delete_logs_event(
    client: APIClient, calendar: Calendar, user: object
) -> None:
    project = Project.objects.create(
        name="Delta", start_date=date(2026, 3, 2), calendar=calendar, is_archived=True
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)

    resp = client.delete(f"/api/v1/projects/{project.pk}/?force=true")
    assert resp.status_code == 204
    event = AuditEvent.objects.get(event_type=AuditEventType.PROJECT_DELETED)
    assert event.metadata == {"mode": "hard"}
    # The Project row is gone, but the denormalized label keeps the log readable.
    assert not Project.objects.filter(pk=project.pk).exists()
    assert event.target_label == "Delta"
