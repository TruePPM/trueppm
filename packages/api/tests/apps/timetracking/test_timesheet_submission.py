"""Tests for the weekly timesheet submission marker (ADR-0224, #1435).

Submit / un-submit is a per-user-per-week marker: no approver, entries stay editable,
``week_start`` normalized to the ISO Monday, and the marker is folded into the weekly
cross-project GET so the grid needs no second round-trip.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.timetracking.models import TimeEntry, TimesheetSubmission

User = get_user_model()

# 2026-06-15 is a Monday; 06-17 (Wed) and 06-21 (Sun) fall in the same ISO week.
MONDAY = "2026-06-15"
WEDNESDAY = "2026-06-17"
SUNDAY = "2026-06-21"


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


def _submit_url(week: str) -> str:
    return f"/api/v1/me/timesheets/{week}/submit"


# ---------------------------------------------------------------------------
# Submit
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_submit_creates_marker(alice: object) -> None:
    resp = _client(alice).post(_submit_url(MONDAY))

    assert resp.status_code == 200
    assert resp.data["week_start"] == MONDAY
    assert resp.data["submitted_at"]  # non-empty ISO timestamp
    assert TimesheetSubmission.objects.filter(user=alice, week_start=date(2026, 6, 15)).exists()


@pytest.mark.django_db
def test_submit_normalizes_non_monday_to_monday(alice: object) -> None:
    """Posting any day of the week canonicalizes to that week's Monday (no fragmentation)."""
    resp = _client(alice).post(_submit_url(WEDNESDAY))

    assert resp.status_code == 200
    assert resp.data["week_start"] == MONDAY
    rows = TimesheetSubmission.objects.filter(user=alice)
    assert rows.count() == 1
    assert rows.first().week_start == date(2026, 6, 15)


@pytest.mark.django_db
def test_resubmit_is_idempotent_and_refreshes_timestamp(alice: object) -> None:
    client = _client(alice)
    first = client.post(_submit_url(MONDAY))
    # A different day of the same week must land on the same (single) row.
    second = client.post(_submit_url(SUNDAY))

    assert first.status_code == second.status_code == 200
    assert TimesheetSubmission.objects.filter(user=alice).count() == 1
    assert second.data["submitted_at"] >= first.data["submitted_at"]


@pytest.mark.django_db
def test_submit_rejects_malformed_date(alice: object) -> None:
    resp = _client(alice).post(_submit_url("not-a-date"))
    assert resp.status_code == 400


@pytest.mark.django_db
def test_submit_requires_authentication() -> None:
    resp = APIClient().post(_submit_url(MONDAY))
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_two_users_submit_same_week_independently(alice: object, bob: object) -> None:
    """The (user, week_start) uniqueness is per-user — two users share a week freely."""
    _client(alice).post(_submit_url(MONDAY))
    _client(bob).post(_submit_url(MONDAY))

    assert TimesheetSubmission.objects.filter(week_start=date(2026, 6, 15)).count() == 2


# ---------------------------------------------------------------------------
# Un-submit
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unsubmit_removes_marker(alice: object) -> None:
    client = _client(alice)
    client.post(_submit_url(MONDAY))

    resp = client.delete(_submit_url(MONDAY))

    assert resp.status_code == 204
    assert not TimesheetSubmission.objects.filter(user=alice).exists()


@pytest.mark.django_db
def test_unsubmit_is_idempotent_when_absent(alice: object) -> None:
    resp = _client(alice).delete(_submit_url(MONDAY))
    assert resp.status_code == 204


@pytest.mark.django_db
def test_unsubmit_does_not_touch_other_users_marker(alice: object, bob: object) -> None:
    _client(bob).post(_submit_url(MONDAY))

    resp = _client(alice).delete(_submit_url(MONDAY))

    assert resp.status_code == 204
    assert TimesheetSubmission.objects.filter(user=bob).exists()  # untouched


# ---------------------------------------------------------------------------
# Folded into the weekly GET
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_weekly_get_reports_unsubmitted_by_default(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)

    resp = _client(alice).get(f"/api/v1/me/time-entries/?from={MONDAY}&to={SUNDAY}")

    assert resp.status_code == 200
    sub = resp.data["submission"]
    assert sub["week_start"] == MONDAY
    assert sub["submitted"] is False
    assert sub["submitted_at"] is None


@pytest.mark.django_db
def test_weekly_get_reflects_submission(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    TimeEntry.objects.create(task=task, user=alice, minutes=60, entry_date=date(2026, 6, 16))
    client = _client(alice)
    client.post(_submit_url(MONDAY))

    resp = client.get(f"/api/v1/me/time-entries/?from={MONDAY}&to={SUNDAY}")

    sub = resp.data["submission"]
    assert sub["submitted"] is True
    assert sub["submitted_at"] is not None
    assert sub["week_start"] == MONDAY


@pytest.mark.django_db
def test_weekly_get_submission_keys_off_monday_of_from(calendar: Calendar, alice: object) -> None:
    """Requesting a window that starts mid-week still resolves to the week's Monday marker."""
    proj = _project(calendar)
    _member(proj, alice)
    _client(alice).post(_submit_url(MONDAY))

    # from = Wednesday; the folded submission must still find the Monday marker.
    resp = _client(alice).get(f"/api/v1/me/time-entries/?from={WEDNESDAY}&to={SUNDAY}")

    assert resp.data["submission"]["week_start"] == MONDAY
    assert resp.data["submission"]["submitted"] is True
