"""Tests for actual_start / actual_finish auto-set and schedule variance (#80)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Baseline, BaselineTask, Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


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


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=5)


def _patch(client: APIClient, task: Task, data: dict) -> object:  # type: ignore[type-arg]
    """PATCH a task with broadcast and scheduling mocked out."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        return client.patch(f"/api/v1/tasks/{task.pk}/", data, format="json")


def _fetch_task(client: APIClient, task: Task, project: Project) -> dict:  # type: ignore[type-arg]
    """GET the task via the list endpoint so baseline annotations are applied."""
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    for item in r.data["results"]:
        if str(item["id"]) == str(task.pk):
            return item  # type: ignore[return-value]
    raise AssertionError(f"Task {task.pk} not found in list response")


# ---------------------------------------------------------------------------
# Auto-set on status transition
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_actual_start_set_on_in_progress(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "IN_PROGRESS"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == timezone.localdate()
    assert task.actual_finish is None


@pytest.mark.django_db
def test_actual_finish_set_on_complete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """Completing a task that never started records the finish but NOT a fake start.

    Stamping ``actual_start = today`` on a card that jumped straight to done would
    pin the scheduler to ``today -> today`` and collapse the bar to a single day.
    Leaving it null lets the progress-aware CPM pass derive the full-duration span
    backward from ``actual_finish`` (ADR-0136).
    """
    r = _patch(client, task, {"status": "COMPLETE"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_actual_start_not_overwritten_on_complete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """If actual_start was set when task went IN_PROGRESS, COMPLETE should not change it."""
    _patch(client, task, {"status": "IN_PROGRESS"})
    task.refresh_from_db()
    original_start = task.actual_start

    _patch(client, task, {"status": "COMPLETE"})
    task.refresh_from_db()
    assert task.actual_start == original_start
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_actual_finish_cleared_on_reopen(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    _patch(client, task, {"status": "COMPLETE"})
    task.refresh_from_db()
    assert task.actual_finish is not None

    _patch(client, task, {"status": "IN_PROGRESS"})
    task.refresh_from_db()
    assert task.actual_finish is None
    assert task.actual_start is not None  # actual_start preserved


@pytest.mark.django_db
def test_on_hold_does_not_set_actual_dates(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "ON_HOLD"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Manual override
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_explicit_actual_start_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    override = "2026-03-15"
    r = _patch(client, task, {"status": "IN_PROGRESS", "actual_start": override})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == date(2026, 3, 15)


@pytest.mark.django_db
def test_explicit_actual_finish_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    override = "2026-04-20"
    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": override})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 20)


@pytest.mark.django_db
def test_explicit_actual_finish_on_reopen_is_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """Carrying an actual_finish INTO a reopen is refused (ADR-1153 sign-off gate).

    This used to be accepted — the test asserted the finish was preserved. It is the
    exact state the gate now exists to prevent: ``engine._is_complete`` reads
    completion as ``actual_finish is not None or percent_complete >= 100``, so an
    IN_PROGRESS task carrying a finish is pinned as done in CPM while the board shows
    it in flight. Reopening clears the finish; re-stating it in the same write is a
    contradiction, not an override.
    """
    _patch(client, task, {"status": "COMPLETE"})

    r = _patch(client, task, {"status": "IN_PROGRESS", "actual_finish": "2026-04-10"})
    assert r.status_code == 400
    assert "actual_finish" in r.data
    task.refresh_from_db()
    assert task.status == "COMPLETE"  # ATOMIC_REQUESTS rolled the whole write back


# ---------------------------------------------------------------------------
# No status change — actual dates not auto-set
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_non_status_patch_does_not_auto_set(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"name": "Renamed"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Schedule variance
# ---------------------------------------------------------------------------


def _make_baseline(project: Project, task: Task, baseline_finish: date) -> Baseline:
    """Create an active baseline with a single BaselineTask snapshot."""
    bl = Baseline.objects.create(project=project, name="B1", is_active=True)
    BaselineTask.objects.create(
        baseline=bl,
        task_id=task.pk,
        task_name=task.name,
        start=date(2026, 4, 7),
        finish=baseline_finish,
        duration=task.duration,
    )
    return bl


@pytest.mark.django_db
def test_schedule_variance_computed(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    # Baseline finish = Apr 10; actual_finish = Apr 13 → 3 days late.
    _make_baseline(project, task, date(2026, 4, 10))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-13"})

    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] == 3  # 3 days late vs baseline


@pytest.mark.django_db
def test_schedule_variance_null_when_incomplete(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] is None


@pytest.mark.django_db
def test_schedule_variance_null_when_no_baseline(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    # Without an active baseline the metric is undefined — no plan to compare against.
    Task.objects.filter(pk=task.pk).update(early_finish=date(2026, 4, 10))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-13"})

    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] is None


@pytest.mark.django_db
def test_schedule_variance_negative_when_early(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    # Baseline finish = Apr 15; actual_finish = Apr 12 → 3 days early.
    _make_baseline(project, task, date(2026, 4, 15))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-12"})

    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] == -3  # 3 days early vs baseline


# ---------------------------------------------------------------------------
# API response includes actual date fields
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_actual_date_fields(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(t for t in results if t["id"] == str(task.pk))
    assert "actual_start" in first
    assert "actual_finish" in first
    assert "schedule_variance_days" in first
    assert first["actual_start"] is None
    assert first["actual_finish"] is None


# ---------------------------------------------------------------------------
# Date-gated NOT_STARTED → IN_PROGRESS auto-transition (#336).
# Setting planned_start ≤ today on a NOT_STARTED task is the system-wide
# signal that work has begun. The same rule fires for every entry point
# (gutter promote, Gantt drag, drawer date edit, integration sync) because
# it lives in the serializer, not in any one frontend hook.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_planned_start_today_promotes_not_started_to_in_progress(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    today = timezone.localdate()
    r = _patch(client, task, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "IN_PROGRESS"
    assert task.actual_start == today  # auto-set by existing IN_PROGRESS rule


@pytest.mark.django_db
def test_planned_start_past_promotes_and_pins_actual_start(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    past = (timezone.localdate() - timedelta(days=14)).isoformat()
    r = _patch(client, task, {"planned_start": past})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "IN_PROGRESS"
    # Past date must be preserved, not overwritten by the auto-`actual_start = today`
    assert task.actual_start == date.fromisoformat(past)


@pytest.mark.django_db
def test_planned_start_future_does_not_promote(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    future = (timezone.localdate() + timedelta(days=14)).isoformat()
    r = _patch(client, task, {"planned_start": future})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "NOT_STARTED"
    assert task.actual_start is None


@pytest.mark.django_db
def test_explicit_status_takes_precedence_over_auto_promotion(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """A caller deliberately back-dating planned_start while keeping the card
    in To Do (e.g. data correction) must not be overridden."""
    today = timezone.localdate()
    r = _patch(
        client,
        task,
        {"planned_start": today.isoformat(), "status": "NOT_STARTED"},
    )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "NOT_STARTED"
    assert task.actual_start is None


@pytest.mark.django_db
def test_backlog_task_is_not_auto_promoted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """BACKLOG → IN_PROGRESS is a separate transition (issue #318); the
    date-gate only applies to NOT_STARTED ('To Do') tasks."""
    backlog_task = Task.objects.create(
        project=project, name="Backlog idea", duration=3, status="BACKLOG"
    )
    today = timezone.localdate()
    r = _patch(client, backlog_task, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    backlog_task.refresh_from_db()
    assert backlog_task.status == "BACKLOG"
    assert backlog_task.actual_start is None


@pytest.mark.django_db
def test_already_in_progress_task_is_not_re_promoted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Rescheduling an IN_PROGRESS task must not reset its actual_start."""
    original_actual = timezone.localdate() - timedelta(days=7)
    in_progress = Task.objects.create(
        project=project,
        name="Active work",
        duration=10,
        status="IN_PROGRESS",
        actual_start=original_actual,
    )
    today = timezone.localdate()
    r = _patch(client, in_progress, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    in_progress.refresh_from_db()
    assert in_progress.status == "IN_PROGRESS"
    assert in_progress.actual_start == original_actual  # preserved


@pytest.mark.django_db
def test_complete_task_is_not_reopened(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Editing planned_start on a closed task must not reopen it."""
    complete = Task.objects.create(project=project, name="Done", duration=2, status="COMPLETE")
    today = timezone.localdate()
    r = _patch(client, complete, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    complete.refresh_from_db()
    assert complete.status == "COMPLETE"


# ---------------------------------------------------------------------------
# ADR-1153 (#3529) — user-editable actual dates: validation + the REVIEW stamp
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_review_transition_stamps_actual_finish(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """The REVIEW transition records a finish date (ADR-1153).

    Before this, the highest-volume completion path — a contributor marking
    ``percent_complete=100``, auto-routed to REVIEW — recorded no actuals at all.
    ``actual_start`` is still left alone (ADR-0136).
    """
    r = _patch(client, task, {"status": "REVIEW"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == timezone.localdate()
    assert task.actual_start is None


@pytest.mark.django_db
def test_contributor_percent_complete_100_records_actual_finish(
    project: Project, calendar: Calendar
) -> None:
    """A Member marking 100% lands in REVIEW *and* records a finish (#3529 gap 1)."""
    member = User.objects.create_user(username="contributor", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    member_client = APIClient()
    member_client.force_authenticate(user=member)
    owned = Task.objects.create(
        project=project,
        name="Contributor work",
        duration=3,
        assignee=member,
        planned_start=date(2026, 4, 1),
        status="IN_PROGRESS",
        actual_start=date(2026, 4, 1),
    )

    r = _patch(member_client, owned, {"percent_complete": 100})
    assert r.status_code == 200, r.content
    owned.refresh_from_db()
    assert owned.status == "REVIEW"
    assert owned.actual_finish == timezone.localdate()
    assert owned.actual_start == date(2026, 4, 1)  # untouched — ADR-0136


@pytest.mark.django_db
def test_review_to_complete_preserves_the_review_finish(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """REVIEW ⇄ COMPLETE keeps the recorded finish rather than clearing + re-stamping.

    Both states mean "delivered". The date that matters is when the work finished
    (stamped on entry to REVIEW), not the day the PM got round to signing off.
    """
    _patch(client, task, {"status": "REVIEW", "actual_finish": "2026-04-10"})
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 10)

    r = _patch(client, task, {"status": "COMPLETE"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 10)


@pytest.mark.django_db
def test_actual_finish_cleared_on_reopen_from_review(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """REVIEW → IN_PROGRESS clears the finish — the other half of the REVIEW stamp.

    Without this the stamp would strand a stale ``actual_finish`` on an in-flight
    task, which the engine reads as complete.
    """
    _patch(client, task, {"status": "REVIEW"})
    task.refresh_from_db()
    assert task.actual_finish is not None

    r = _patch(client, task, {"status": "IN_PROGRESS"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish is None


@pytest.mark.django_db
def test_actual_start_after_actual_finish_is_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """The ordering rule mirrors the engine's own ``_validate_task_actual_order``.

    Accepting this pair would not fail *this* row — it would raise
    ``InvalidScheduleInput`` at compute time and fail the whole project's recompute.
    """
    r = _patch(
        client,
        task,
        {"status": "COMPLETE", "actual_start": "2026-04-20", "actual_finish": "2026-04-10"},
    )
    assert r.status_code == 400
    assert "actual_finish" in r.data
    assert "earlier than actual start" in str(r.data["actual_finish"][0])


@pytest.mark.django_db
def test_actual_start_crossing_stored_actual_finish_is_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """Operands resolve payload-else-instance, so a one-field PATCH still trips it."""
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-10"})
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 10)

    r = _patch(client, task, {"actual_start": "2026-04-20"})
    assert r.status_code == 400
    assert "actual_finish" in r.data


@pytest.mark.django_db
def test_future_actual_date_is_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    future = (timezone.localdate() + timedelta(days=1)).isoformat()
    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": future})
    assert r.status_code == 400
    assert "cannot be in the future" in str(r.data["actual_finish"][0])


@pytest.mark.django_db
def test_stale_status_date_does_not_block_recording_today(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """A project last statused months ago must not reject a finish of *today*.

    The bound is ``max(data date, today)`` precisely so a stale ``status_date`` — the
    common case — cannot make the most ordinary entry a 400.
    """
    project.status_date = timezone.localdate() - timedelta(days=120)
    project.save(update_fields=["status_date"])

    r = _patch(
        client, task, {"status": "COMPLETE", "actual_finish": timezone.localdate().isoformat()}
    )
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_forward_status_date_widens_the_upper_bound(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """A deliberately forward-dated data date is honored — that is what ``max`` buys."""
    ahead = timezone.localdate() + timedelta(days=10)
    project.status_date = ahead
    project.save(update_fields=["status_date"])

    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": ahead.isoformat()})
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.actual_finish == ahead


@pytest.mark.django_db
def test_actual_finish_on_in_progress_task_is_rejected(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """The sign-off gate: a bare finish on an in-flight task is refused (ai-review §3).

    ``engine._is_complete`` reads ``actual_finish is not None``, so this write would
    pin the task as done in CPM while the board still shows it in progress.
    """
    active = Task.objects.create(project=project, name="Active", duration=4, status="IN_PROGRESS")
    r = _patch(client, active, {"actual_finish": "2026-04-10"})
    assert r.status_code == 400
    assert "in review or complete" in str(r.data["actual_finish"][0])


@pytest.mark.django_db
def test_actual_finish_with_status_in_one_write_is_accepted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """The gate resolves status payload-else-instance, so one write is enough.

    This is the path an agent, integration, or offline client uses; the gate must not
    force it into two round trips.
    """
    active = Task.objects.create(project=project, name="Active", duration=4, status="IN_PROGRESS")
    r = _patch(client, active, {"status": "COMPLETE", "actual_finish": "2026-04-10"})
    assert r.status_code == 200, r.content
    active.refresh_from_db()
    assert active.actual_finish == date(2026, 4, 10)


@pytest.mark.django_db
def test_actual_start_alone_on_in_progress_task_is_accepted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """``actual_start`` carries no status gate — ADR-0136 keeps it the permissive half."""
    active = Task.objects.create(project=project, name="Active", duration=4, status="IN_PROGRESS")
    r = _patch(client, active, {"actual_start": "2026-04-01"})
    assert r.status_code == 200, r.content
    active.refresh_from_db()
    assert active.actual_start == date(2026, 4, 1)


@pytest.mark.django_db
def test_half_populated_row_is_valid(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """A finish with no start is by design (ADR-0136), not an incomplete state."""
    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-10"})
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish == date(2026, 4, 10)


@pytest.mark.django_db
def test_unrelated_patch_on_a_row_with_invalid_actuals_is_not_blocked(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Legacy/imported rows stay editable through every other field.

    Same policy as ``_validate_three_point_order`` and ``_enforce_project_span``: the
    guard arms only when the write touches an actual field, so pre-existing bad data
    does not make a task permanently un-renamable.
    """
    legacy = Task.objects.create(
        project=project,
        name="Imported",
        duration=4,
        status="COMPLETE",
        actual_start=date(2026, 4, 20),
        actual_finish=date(2026, 4, 10),
    )
    r = _patch(client, legacy, {"name": "Imported (renamed)"})
    assert r.status_code == 200, r.content
    legacy.refresh_from_db()
    assert legacy.name == "Imported (renamed)"


@pytest.mark.django_db
def test_member_without_write_access_cannot_set_actual_dates(
    project: Project, membership: ProjectMembership
) -> None:
    """The permission gate is the ordinary task-write gate — no new surface."""
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    viewer_client = APIClient()
    viewer_client.force_authenticate(user=viewer)
    target = Task.objects.create(project=project, name="Locked", duration=2, status="COMPLETE")

    r = _patch(viewer_client, target, {"actual_finish": "2026-04-10"})
    assert r.status_code in (403, 404)
    target.refresh_from_db()
    assert target.actual_finish is None


@pytest.mark.django_db
def test_actual_date_far_before_project_start_is_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """The span cap applies in BOTH directions — found by the ADR-1153 sibling sweep.

    ``_validate_span_bounds`` measures an actual as an ABSOLUTE offset from the project
    start, so a date far in the past detonates the recompute exactly like one far in the
    future. The future bound alone does not reach that direction, and a date input
    carries no floor, so a typed 1900-01-01 would otherwise be accepted here.
    """
    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": "0900-01-01"})
    assert r.status_code == 400
    assert "representable date range" in str(r.data["actual_finish"][0])


@pytest.mark.django_db
def test_create_with_actual_finish_and_no_status_is_rejected(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """The sign-off gate does NOT skip on CREATE.

    A field gate written as ``if self.instance is not None`` runs only on UPDATE and is
    silently bypassed at POST. This one resolves status payload-else-instance, so on a
    create with no status the effective status is ``None`` — not a sign-off state — and
    the write is refused.
    """
    r = client.post(
        "/api/v1/tasks/",
        {
            "project": str(project.pk),
            "name": "Imported done",
            "duration": 3,
            "actual_finish": "2026-04-10",
        },
        format="json",
    )
    assert r.status_code == 400
    assert "actual_finish" in r.data


@pytest.mark.django_db
def test_create_complete_task_with_actual_finish_is_accepted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """…but a create that declares the sign-off status in the same payload works."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.post(
            "/api/v1/tasks/",
            {
                "project": str(project.pk),
                "name": "Imported done",
                "duration": 3,
                "status": "COMPLETE",
                "actual_finish": "2026-04-10",
            },
            format="json",
        )
    assert r.status_code == 201, r.content
    assert Task.objects.get(pk=r.data["id"]).actual_finish == date(2026, 4, 10)


@pytest.mark.django_db
def test_actuals_only_edit_enqueues_a_recompute_and_broadcasts(
    client: APIClient,
    task: Task,
    membership: ProjectMembership,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """A drawer edit of an actual date must re-run CPM — it MOVES the task's pin.

    ``_NON_SCHEDULE_TASK_FIELDS`` is ``{"notes", "name", "board_lane"}``; anything
    outside it enqueues a recompute. Asserted rather than assumed, because the whole
    point of an actual date is that the engine pins placement to it (ADR-0132/0136) —
    if actuals were ever added to that set, the correction would persist and the
    schedule would silently keep the old dates. The broadcast rides the same commit,
    carrying FIELD NAMES only (ADR-0152), so no value is fanned out unfiltered.
    """
    _patch(client, task, {"status": "COMPLETE"})

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as enqueue,
        patch("trueppm_api.apps.sync.broadcast.broadcast_task_updated") as broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/", {"actual_finish": "2026-04-08"}, format="json"
        )

    assert r.status_code == 200, r.content
    enqueue.assert_called_once()
    broadcast.assert_called_once()
    assert "actual_finish" in broadcast.call_args.kwargs["changed_fields"]


@pytest.mark.django_db
def test_a_refused_actuals_write_broadcasts_nothing(
    client: APIClient,
    task: Task,
    membership: ProjectMembership,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """A 400 must not fan out a phantom update.

    DRF's exception handler calls ``set_rollback()`` for every ``APIException``, and
    under ``ATOMIC_REQUESTS`` that discards the pending ``on_commit`` callbacks along
    with the write — so the broadcast is dropped rather than announcing a state the
    database never held.
    """
    _patch(client, task, {"status": "COMPLETE"})

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
        # Also patched here: the non-transactional test wraps everything in one
        # uncommitted transaction, so the SETUP write's on_commit callbacks are still
        # pending and run inside this capture block.
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_task_updated") as broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"actual_start": "2026-04-20", "actual_finish": "2026-04-10"},
            format="json",
        )

    assert r.status_code == 400
    broadcast.assert_not_called()


# ---------------------------------------------------------------------------
# Shared ADR-1153 rules module (#3709) — direct unit coverage of
# projects.actual_date_rules, extracted so REST, the MS Project importer, and
# seed replay enforce one implementation instead of two that can drift.
# ---------------------------------------------------------------------------


def test_check_actual_date_order_flags_an_inverted_pair() -> None:
    from trueppm_api.apps.projects.actual_date_rules import check_actual_date_order

    violation = check_actual_date_order(date(2026, 4, 20), date(2026, 4, 10))
    assert violation is not None
    assert violation.field == "actual_finish"
    assert violation.code == "actual_dates_out_of_order"


def test_check_actual_date_order_allows_a_coherent_or_half_populated_pair() -> None:
    from trueppm_api.apps.projects.actual_date_rules import check_actual_date_order

    assert check_actual_date_order(date(2026, 4, 1), date(2026, 4, 10)) is None
    assert check_actual_date_order(None, date(2026, 4, 10)) is None
    assert check_actual_date_order(date(2026, 4, 1), None) is None


@pytest.mark.django_db
def test_check_actual_date_bound_flags_a_future_date(project: Project) -> None:
    from trueppm_api.apps.projects.actual_date_rules import check_actual_date_bound

    future = timezone.localdate() + timedelta(days=5)
    violation = check_actual_date_bound("actual_finish", "Actual finish", future, project)
    assert violation is not None
    assert violation.code == "actual_date_in_future"


@pytest.mark.django_db
def test_check_actual_date_bound_flags_a_date_outside_the_span(project: Project) -> None:
    from trueppm_api.apps.projects.actual_date_rules import check_actual_date_bound

    violation = check_actual_date_bound("actual_finish", "Actual finish", date(900, 1, 1), project)
    assert violation is not None
    assert violation.code == "actual_date_outside_span"


@pytest.mark.django_db
def test_check_actual_date_bound_allows_a_date_in_range(project: Project) -> None:
    from trueppm_api.apps.projects.actual_date_rules import check_actual_date_bound

    assert check_actual_date_bound("actual_start", "Actual start", None, project) is None
    assert (
        check_actual_date_bound("actual_start", "Actual start", timezone.localdate(), project)
        is None
    )


def test_check_actual_finish_signoff_flags_a_non_signoff_status() -> None:
    from trueppm_api.apps.projects.actual_date_rules import check_actual_finish_signoff

    violation = check_actual_finish_signoff(date(2026, 4, 1), "IN_PROGRESS")
    assert violation is not None
    assert violation.code == "actual_finish_requires_signoff"

    assert check_actual_finish_signoff(date(2026, 4, 1), "REVIEW") is None
    assert check_actual_finish_signoff(date(2026, 4, 1), "COMPLETE") is None
    assert check_actual_finish_signoff(None, "IN_PROGRESS") is None


@pytest.mark.django_db
def test_check_actual_dates_composes_all_three_rules(project: Project) -> None:
    """The full-row convenience wrapper used by the importer/seed replay — not
    the serializer, which needs the partial-PATCH field-touch semantics its own
    ``_validate_actual_dates`` docstring describes."""
    from trueppm_api.apps.projects.actual_date_rules import check_actual_dates

    assert (
        check_actual_dates(
            actual_start=date(2026, 4, 1),
            actual_finish=date(2026, 4, 10),
            status="COMPLETE",
            project=project,
        )
        is None
    )

    order_violation = check_actual_dates(
        actual_start=date(2026, 4, 20),
        actual_finish=date(2026, 4, 10),
        status="COMPLETE",
        project=project,
    )
    assert order_violation is not None
    assert order_violation.code == "actual_dates_out_of_order"

    signoff_violation = check_actual_dates(
        actual_start=None,
        actual_finish=date(2026, 4, 10),
        status="IN_PROGRESS",
        project=project,
    )
    assert signoff_violation is not None
    assert signoff_violation.code == "actual_finish_requires_signoff"
