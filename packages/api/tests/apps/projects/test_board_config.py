"""Tests for BoardColumnConfig GET/PUT endpoint."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import BoardColumnConfig, Calendar, Project

User = get_user_model()

# 5-column default per Claude Design handoff (issue #178).
DEFAULT_COLUMNS = [
    {"status": "BACKLOG", "label": "Backlog", "visible": True},
    {"status": "NOT_STARTED", "label": "To Do", "visible": True},
    {"status": "IN_PROGRESS", "label": "In Progress", "visible": True},
    {"status": "REVIEW", "label": "Review", "visible": True},
    {"status": "COMPLETE", "label": "Done", "visible": True},
]


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    return Project.objects.create(name="Board Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def scheduler_user(db):
    return User.objects.create_user(username="scheduler", password="pw")


@pytest.fixture
def member_user(db):
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def scheduler_client(scheduler_user, project):
    ProjectMembership.objects.create(project=project, user=scheduler_user, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=scheduler_user)
    return client


@pytest.fixture
def member_client(member_user, project):
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member_user)
    return client


@pytest.mark.django_db
def test_get_returns_defaults_when_no_config(scheduler_client, project):
    """GET returns the 5-column default when no config row exists."""
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert resp.status_code == 200
    assert resp.data["columns"] == DEFAULT_COLUMNS


@pytest.mark.django_db
def test_put_saves_config(scheduler_client, project):
    """PUT creates a config and GET reflects it."""
    new_columns = [
        {"status": "BACKLOG", "label": "Ideas", "visible": True},
        {"status": "NOT_STARTED", "label": "Up Next", "visible": True},
        {"status": "IN_PROGRESS", "label": "Doing", "visible": True},
        {"status": "REVIEW", "label": "In Review", "visible": False},
        {"status": "COMPLETE", "label": "Done", "visible": True},
    ]
    put_resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": new_columns},
        format="json",
    )
    assert put_resp.status_code == 200
    assert put_resp.data["columns"] == new_columns

    get_resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert get_resp.data["columns"] == new_columns


@pytest.mark.django_db
def test_put_is_idempotent(scheduler_client, project):
    """Repeated PUTs update the single config row (no duplicates)."""
    cols = DEFAULT_COLUMNS[:]
    scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": cols},
        format="json",
    )
    scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": cols},
        format="json",
    )
    assert BoardColumnConfig.objects.filter(project=project).count() == 1


@pytest.mark.django_db
def test_member_can_read_config(member_client, project):
    """A MEMBER (role=1) can read the config."""
    resp = member_client.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_member_cannot_write_config(member_client, project):
    """A MEMBER (role=1) cannot PUT the config (requires SCHEDULER)."""
    resp = member_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": DEFAULT_COLUMNS},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_put_rejects_unknown_status(scheduler_client, project):
    """PUT rejects a column with an unknown status value (e.g. ON_HOLD legacy value)."""
    bad_columns = [
        {"status": "ON_HOLD", "label": "On Hold", "visible": True},  # legacy
        {"status": "NOT_STARTED", "label": "To Do", "visible": True},
        {"status": "IN_PROGRESS", "label": "In Progress", "visible": True},
        {"status": "REVIEW", "label": "Review", "visible": True},
        {"status": "COMPLETE", "label": "Done", "visible": True},
    ]
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": bad_columns},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_put_rejects_missing_status(scheduler_client, project):
    """PUT rejects a payload missing one of the five canonical statuses."""
    partial = [
        {"status": "NOT_STARTED", "label": "To Do", "visible": True},
        {"status": "IN_PROGRESS", "label": "In Progress", "visible": True},
        {"status": "REVIEW", "label": "Review", "visible": True},
        {"status": "COMPLETE", "label": "Done", "visible": True},
        # BACKLOG missing
    ]
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": partial},
        format="json",
    )
    assert resp.status_code == 400
