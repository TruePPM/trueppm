"""Tests for the can_log_time serializer field and sync isolation (ADR-0185 §3/§6, #1258).

* ``TaskSerializer.can_log_time`` reflects the same predicate ``CanLogTime`` enforces.
* The per-project sync delta returns only the caller's own entries, and a soft-deleted
  entry yields a tombstone — no cross-user leak through the offline channel.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.serializers import TaskSerializer
from trueppm_api.apps.timetracking.models import TimeEntry

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


def _project(calendar: Calendar, name: str = "P1") -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _member(project: Project, user: object, role: int = Role.MEMBER) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _task(project: Project, name: str = "T1") -> Task:
    return Task.objects.create(project=project, name=name, duration=1)


def _request(user: object) -> object:
    from rest_framework.test import APIRequestFactory

    req = APIRequestFactory().get("/")
    req.user = user  # type: ignore[attr-defined]
    return req


# ---------------------------------------------------------------------------
# TaskSerializer.can_log_time
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_can_log_time_true_for_member(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice, Role.MEMBER)
    task = _task(proj)
    data = TaskSerializer(task, context={"request": _request(alice)}).data
    assert data["can_log_time"] is True


@pytest.mark.django_db
def test_can_log_time_false_for_viewer(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice, Role.VIEWER)
    task = _task(proj)
    data = TaskSerializer(task, context={"request": _request(alice)}).data
    assert data["can_log_time"] is False


@pytest.mark.django_db
def test_can_log_time_false_for_non_member(calendar: Calendar, alice: object, bob: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    data = TaskSerializer(task, context={"request": _request(bob)}).data
    assert data["can_log_time"] is False


@pytest.mark.django_db
def test_can_log_time_false_without_request(calendar: Calendar, alice: object) -> None:
    """Nested serialization (no request) fails closed to False."""
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    data = TaskSerializer(task).data
    assert data["can_log_time"] is False


# ---------------------------------------------------------------------------
# Sync isolation
# ---------------------------------------------------------------------------


def _sync_pull(client: APIClient, project: Project) -> object:
    return client.get(f"/api/v1/projects/{project.pk}/sync/?since=0")


@pytest.mark.django_db
def test_sync_delta_returns_only_own_time_entries(
    calendar: Calendar, alice: object, bob: object
) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    _member(proj, bob)
    task = _task(proj)
    mine = TimeEntry.objects.create(task=task, user=alice, minutes=60)
    theirs = TimeEntry.objects.create(task=task, user=bob, minutes=30)

    client = APIClient()
    client.force_authenticate(user=alice)
    resp = _sync_pull(client, proj)

    assert resp.status_code == 200
    te = resp.data["changes"]["time_entries"]
    ids = {row["id"] for row in te["updated"]}
    assert str(mine.pk) in ids
    assert str(theirs.pk) not in ids  # no cross-user leak through sync


@pytest.mark.django_db
def test_sync_soft_deleted_entry_is_tombstone(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    entry = TimeEntry.objects.create(task=task, user=alice, minutes=60)
    entry.soft_delete()

    client = APIClient()
    client.force_authenticate(user=alice)
    resp = _sync_pull(client, proj)

    te = resp.data["changes"]["time_entries"]
    assert str(entry.pk) in set(te["deleted"])
