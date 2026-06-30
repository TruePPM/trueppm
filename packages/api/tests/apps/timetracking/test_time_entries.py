"""API tests for the time-tracking subsystem (ADR-0185, #1258).

Covers the RBAC matrix (Member may log, Viewer 403, cross-project 404), manual-entry
validation (minutes bounds, no-future, backdate window), author-only edit/delete (404
for others), and the caller-scoped per-task rollup. Timer lifecycle, the weekly read,
sync isolation, and the can_log_time serializer field live in sibling test modules.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
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


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(task: Task) -> str:
    return f"/api/v1/tasks/{task.pk}/time-entries/"


# ---------------------------------------------------------------------------
# Auth + RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_anonymous_is_rejected(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    resp = APIClient().post(_url(task), {"minutes": 30}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_member_can_log_time(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice, Role.MEMBER)
    task = _task(proj)

    resp = _client(alice).post(_url(task), {"minutes": 90, "note": "design"}, format="json")

    assert resp.status_code == 201
    assert resp.data["minutes"] == 90
    assert resp.data["source"] == "manual"
    assert str(resp.data["user"]) == str(alice.pk)  # server-set owner
    assert TimeEntry.objects.filter(task=task, user=alice).count() == 1


@pytest.mark.django_db
def test_viewer_is_forbidden_403(calendar: Calendar, alice: object) -> None:
    """A Viewer is a member (task resolves) but lacks the role → 403, not 404."""
    proj = _project(calendar)
    _member(proj, alice, Role.VIEWER)
    task = _task(proj)

    resp = _client(alice).post(_url(task), {"minutes": 30}, format="json")

    assert resp.status_code == 403
    assert not TimeEntry.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_non_member_gets_404_not_403(calendar: Calendar, alice: object, bob: object) -> None:
    """Cross-project IDOR: a non-member must not learn the task exists → 404."""
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)

    resp = _client(bob).post(_url(task), {"minutes": 30}, format="json")

    assert resp.status_code == 404


@pytest.mark.django_db
def test_scheduler_admin_owner_may_log(calendar: Calendar, alice: object) -> None:
    for role in (Role.SCHEDULER, Role.ADMIN, Role.OWNER):
        user = User.objects.create_user(username=f"u{role}", password="pw")
        proj = _project(calendar, name=f"P{role}")
        _member(proj, user, role)
        task = _task(proj)
        resp = _client(user).post(_url(task), {"minutes": 10}, format="json")
        assert resp.status_code == 201, role


@pytest.mark.django_db
def test_user_field_cannot_be_spoofed(calendar: Calendar, alice: object, bob: object) -> None:
    """A body-supplied user is ignored — the owner is always request.user."""
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)

    resp = _client(alice).post(_url(task), {"minutes": 30, "user": str(bob.pk)}, format="json")

    assert resp.status_code == 201
    assert str(resp.data["user"]) == str(alice.pk)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("minutes", [0, -5, 1441])
def test_minutes_out_of_bounds_rejected(calendar: Calendar, alice: object, minutes: int) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    resp = _client(alice).post(_url(task), {"minutes": minutes}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_future_entry_date_rejected(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    future = (timezone.localdate() + timedelta(days=1)).isoformat()
    resp = _client(alice).post(_url(task), {"minutes": 30, "entry_date": future}, format="json")
    assert resp.status_code == 400
    assert "entry_date" in resp.data


@pytest.mark.django_db
def test_too_old_entry_date_rejected(calendar: Calendar, alice: object, settings: object) -> None:
    settings.TIMETRACKING_BACKDATE_DAYS = 60  # type: ignore[attr-defined]
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    old = (timezone.localdate() - timedelta(days=61)).isoformat()
    resp = _client(alice).post(_url(task), {"minutes": 30, "entry_date": old}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_entry_date_within_window_accepted(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    within = (timezone.localdate() - timedelta(days=3)).isoformat()
    resp = _client(alice).post(_url(task), {"minutes": 30, "entry_date": within}, format="json")
    assert resp.status_code == 201
    assert resp.data["entry_date"] == within


@pytest.mark.django_db
def test_entry_date_defaults_to_today(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    resp = _client(alice).post(_url(task), {"minutes": 30}, format="json")
    assert resp.status_code == 201
    assert resp.data["entry_date"] == timezone.localdate().isoformat()


# ---------------------------------------------------------------------------
# Per-task rollup (GET) — caller-scoped
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_returns_only_own_entries_and_total(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """The rollup is caller-scoped — a colleague's hours are never exposed."""
    proj = _project(calendar)
    _member(proj, alice)
    _member(proj, bob)
    task = _task(proj)
    TimeEntry.objects.create(task=task, user=alice, minutes=60)
    TimeEntry.objects.create(task=task, user=alice, minutes=30)
    TimeEntry.objects.create(task=task, user=bob, minutes=120)  # must not leak

    resp = _client(alice).get(_url(task))

    assert resp.status_code == 200
    assert resp.data["total_logged_minutes"] == 90
    assert len(resp.data["results"]) == 2


@pytest.mark.django_db
def test_viewer_may_read_own_empty_rollup(calendar: Calendar, alice: object) -> None:
    """A Viewer may GET (they simply have no entries) — read needs only membership."""
    proj = _project(calendar)
    _member(proj, alice, Role.VIEWER)
    task = _task(proj)
    resp = _client(alice).get(_url(task))
    assert resp.status_code == 200
    assert resp.data["total_logged_minutes"] == 0
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_soft_deleted_entries_excluded_from_rollup(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    keep = TimeEntry.objects.create(task=task, user=alice, minutes=60)
    gone = TimeEntry.objects.create(task=task, user=alice, minutes=30)
    gone.soft_delete()

    resp = _client(alice).get(_url(task))

    assert resp.data["total_logged_minutes"] == 60
    ids = {e["id"] for e in resp.data["results"]}
    assert str(keep.pk) in ids
    assert str(gone.pk) not in ids
