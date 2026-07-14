"""Tests for the user-scoped (`/me/`) time-entry surfaces (ADR-0185 §4, #1258).

Author-only detail edit/delete (404 for others), the weekly cross-project rollup with
its precomputed totals, and the N+1 guard on the weekly read.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
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


# ---------------------------------------------------------------------------
# Detail — author-only PATCH / DELETE
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_author_can_patch_own_entry(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    entry = TimeEntry.objects.create(task=task, user=alice, minutes=30)

    resp = _client(alice).patch(
        f"/api/v1/me/time-entries/{entry.pk}/", {"minutes": 45}, format="json"
    )

    assert resp.status_code == 200
    assert resp.data["minutes"] == 45
    entry.refresh_from_db()
    assert entry.minutes == 45


@pytest.mark.django_db
def test_patch_other_users_entry_is_404(calendar: Calendar, alice: object, bob: object) -> None:
    """Editing another user's entry is an existence-oracle close → 404, never 403."""
    proj = _project(calendar)
    _member(proj, alice)
    _member(proj, bob)
    task = _task(proj)
    entry = TimeEntry.objects.create(task=task, user=alice, minutes=30)

    resp = _client(bob).patch(
        f"/api/v1/me/time-entries/{entry.pk}/", {"minutes": 999}, format="json"
    )

    assert resp.status_code == 404
    entry.refresh_from_db()
    assert entry.minutes == 30  # untouched


@pytest.mark.django_db
def test_author_can_soft_delete_own_entry(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    entry = TimeEntry.objects.create(task=task, user=alice, minutes=30)

    resp = _client(alice).delete(f"/api/v1/me/time-entries/{entry.pk}/")

    assert resp.status_code == 204
    entry.refresh_from_db()
    assert entry.is_deleted is True  # soft-delete → tombstone, not a hard delete
    assert entry.deleted_version is not None
    # #1888: the delete is attributed so the activity stream can synthesize a
    # time_deleted event — deleted_at anchors it, deleted_by is the acting owner.
    assert entry.deleted_at is not None
    assert entry.deleted_by_id == alice.pk  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_delete_other_users_entry_is_404(calendar: Calendar, alice: object, bob: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    _member(proj, bob)
    task = _task(proj)
    entry = TimeEntry.objects.create(task=task, user=alice, minutes=30)

    resp = _client(bob).delete(f"/api/v1/me/time-entries/{entry.pk}/")

    assert resp.status_code == 404
    entry.refresh_from_db()
    assert entry.is_deleted is False


@pytest.mark.django_db
def test_patch_cannot_set_future_date(calendar: Calendar, alice: object) -> None:
    from django.utils import timezone

    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    entry = TimeEntry.objects.create(task=task, user=alice, minutes=30)
    future = (timezone.localdate() + timedelta(days=2)).isoformat()

    resp = _client(alice).patch(
        f"/api/v1/me/time-entries/{entry.pk}/", {"entry_date": future}, format="json"
    )

    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Weekly cross-project rollup
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_weekly_aggregates_across_projects(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "P1")
    p2 = _project(calendar, "P2")
    _member(p1, alice)
    _member(p2, alice)
    t1 = _task(p1, "A")
    t2 = _task(p2, "B")
    TimeEntry.objects.create(task=t1, user=alice, minutes=60, entry_date=date(2026, 6, 1))
    TimeEntry.objects.create(task=t1, user=alice, minutes=30, entry_date=date(2026, 6, 1))
    TimeEntry.objects.create(task=t2, user=alice, minutes=120, entry_date=date(2026, 6, 2))

    resp = _client(alice).get("/api/v1/me/time-entries/?from=2026-06-01&to=2026-06-07")

    assert resp.status_code == 200
    assert len(resp.data["results"]) == 3
    totals = resp.data["totals"]
    assert totals["by_day"]["2026-06-01"] == 90
    assert totals["by_day"]["2026-06-02"] == 120
    assert totals["by_cell"][f"{t1.pk}|2026-06-01"] == 90
    assert totals["week_minutes"] == 210
    # results carry the denormalized task/project labels the grid renders
    row = resp.data["results"][0]
    assert {"task_short_id", "task_name", "project", "project_name"} <= set(row)


@pytest.mark.django_db
def test_weekly_today_minutes(calendar: Calendar, alice: object) -> None:
    from django.utils import timezone

    today = timezone.localdate()
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    TimeEntry.objects.create(task=task, user=alice, minutes=45, entry_date=today)

    frm = (today - timedelta(days=today.weekday())).isoformat()
    to = (today + timedelta(days=6)).isoformat()
    resp = _client(alice).get(f"/api/v1/me/time-entries/?from={frm}&to={to}")

    assert resp.data["totals"]["today_minutes"] == 45


@pytest.mark.django_db
def test_weekly_excludes_other_users(calendar: Calendar, alice: object, bob: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    _member(proj, bob)
    task = _task(proj)
    TimeEntry.objects.create(task=task, user=alice, minutes=60, entry_date=date(2026, 6, 1))
    TimeEntry.objects.create(task=task, user=bob, minutes=999, entry_date=date(2026, 6, 1))

    resp = _client(alice).get("/api/v1/me/time-entries/?from=2026-06-01&to=2026-06-07")

    assert resp.data["totals"]["week_minutes"] == 60


@pytest.mark.django_db
def test_weekly_drops_removed_membership(calendar: Calendar, alice: object) -> None:
    """Defence-in-depth: an entry on a project the user was removed from is excluded."""
    proj = _project(calendar)
    membership = _member(proj, alice)
    task = _task(proj)
    TimeEntry.objects.create(task=task, user=alice, minutes=60, entry_date=date(2026, 6, 1))
    membership.soft_delete()

    resp = _client(alice).get("/api/v1/me/time-entries/?from=2026-06-01&to=2026-06-07")

    assert resp.status_code == 200
    assert resp.data["results"] == []
    assert resp.data["totals"]["week_minutes"] == 0


@pytest.mark.django_db
def test_weekly_requires_both_or_neither_bound(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    resp = _client(alice).get("/api/v1/me/time-entries/?from=2026-06-01")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_weekly_defaults_to_current_week(calendar: Calendar, alice: object) -> None:
    from django.utils import timezone

    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    TimeEntry.objects.create(task=task, user=alice, minutes=30, entry_date=timezone.localdate())

    resp = _client(alice).get("/api/v1/me/time-entries/")

    assert resp.status_code == 200
    assert resp.data["totals"]["week_minutes"] == 30


@pytest.mark.django_db
def test_weekly_rejects_inverted_range(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    resp = _client(alice).get("/api/v1/me/time-entries/?from=2026-06-07&to=2026-06-01")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_weekly_read_is_n_plus_one_safe(calendar: Calendar, alice: object) -> None:
    """select_related keeps the weekly read query-bounded regardless of row count."""
    proj = _project(calendar)
    _member(proj, alice)
    # Spread entries across several tasks so a naive per-row task/project read
    # would fan out into N+1.
    for i in range(6):
        task = _task(proj, f"T{i}")
        TimeEntry.objects.create(task=task, user=alice, minutes=15, entry_date=date(2026, 6, 1))

    client = _client(alice)
    with CaptureQueriesContext(connection) as ctx:
        resp = client.get("/api/v1/me/time-entries/?from=2026-06-01&to=2026-06-07")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 6
    # Auth/session + the single select_related entry fetch; a small constant, not O(rows).
    assert len(ctx.captured_queries) <= 8, [q["sql"] for q in ctx.captured_queries]
