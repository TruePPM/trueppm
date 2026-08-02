"""Tests for arming the CPM status_date floor and its one-shot suppression (#2676).

ADR-0752 §4 corrects ADR-0132 §1: a null `Project.status_date` used to pass
raw to the deterministic CPM pass (`schedule()`), meaning "no floor at all" —
Monte Carlo already floored a null value at today, but CPM did not. Arming
that floor moves dates once, on the first recalculation after it ships, for
any project that already carries CPM dates and has never had the floor armed
before (`Project.status_date_floor_armed_at` is null). ADR-0752 §7 requires
that one-time date shift to not be reported as ordinary per-task movement: no
`cpm_recalculated` TaskActivityEvent rows, and no `task_dates_updated`
ADR-0091 broadcast, on that specific recalculation. Every recalculation after
that — including ones still resolving a null `status_date` to today — reports
movement normally.

Covers: the resolved status_date is echoed on the schedule payload
(`cpm_complete` broadcast, `TaskRun.result_summary`); the arming run suppresses
per-task movement on both surfaces; a follow-up genuine-movement recalculation
does not; a project with an explicit `status_date` is never treated as arming
(unaffected, since it was already floored); and a brand-new project's
first-ever CPM pass is not treated as "arming" either (see
test_schedule_shift_emit.py's null -> computed coverage — nothing here moved
*from* anywhere).
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.utils import timezone as dj_timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Task,
    TaskActivityEvent,
)
from trueppm_api.apps.scheduling.tasks import _run_schedule

_FROZEN_TODAY = date(2026, 8, 1)


@pytest.fixture(autouse=True)
def pin_today(monkeypatch: pytest.MonkeyPatch) -> None:
    """Freeze `timezone.localdate()` so status_date-floor assertions never
    depend on the wall-clock day the suite happens to run on — same pattern as
    test_monte_carlo_status_date.py's `_pin_today`."""
    monkeypatch.setattr(dj_timezone, "localdate", lambda *a, **kw: _FROZEN_TODAY)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="ArmingShift")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="ArmingProj", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def chain(project: Project) -> tuple[Task, Task, Task]:
    """A -> B -> C, all FS, duration 2 — same shape as test_schedule_shift_emit.py."""
    a = Task.objects.create(project=project, name="A", duration=2)
    b = Task.objects.create(project=project, name="B", duration=2)
    c = Task.objects.create(project=project, name="C", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")
    Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")
    return a, b, c


def _run(project_id: str) -> tuple[Any, Any]:
    """Run `_run_schedule` with broadcasts/webhooks mocked; return the mocks."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast_mock,
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks") as webhook_mock,
    ):
        _run_schedule(project_id)
    return broadcast_mock, webhook_mock


def _event_types(broadcast_mock: Any) -> list[str]:
    return [call.kwargs["event_type"] for call in broadcast_mock.call_args_list]


def _payload_for(broadcast_mock: Any, event_type: str) -> dict[str, object]:
    for call in broadcast_mock.call_args_list:
        if call.kwargs["event_type"] == event_type:
            return call.kwargs["payload"]  # type: ignore[no-any-return]
    raise AssertionError(f"no {event_type} broadcast was made")


@pytest.mark.django_db(transaction=True)
class TestStatusDateFloorArming:
    def test_established_project_arming_run_floors_and_echoes_but_suppresses_movement(
        self, project: Project, chain: tuple[Task, Task, Task]
    ) -> None:
        """The realistic upgrade scenario: a project that already has CPM dates
        from before this change shipped (status_date_floor_armed_at was never
        tracked), and no explicit status_date. Its next recalculation arms the
        floor, echoes the resolved date, and suppresses per-task movement on
        both the activity feed and the ADR-0091 broadcast."""
        a, _, _ = chain

        # Establish a prior schedule (as if this ran under the old code before
        # this change shipped) — this also sets status_date_floor_armed_at,
        # since it is this project's first-ever CPM pass; reset it below to
        # simulate a project that predates the armed-flag column entirely.
        _run(str(project.pk))
        project.refresh_from_db()
        assert project.status_date_floor_armed_at is not None
        Project.objects.filter(pk=project.pk).update(status_date_floor_armed_at=None)
        pre_arming_count = TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count()

        # Force real movement so the arming run has something to (not) report:
        # lengthening A pushes B and C's remaining-work windows out too.
        Task.objects.filter(pk=a.pk).update(duration=6)

        broadcast_mock, _ = _run(str(project.pk))

        # Suppressed: no new cpm_recalculated rows, no task_dates_updated broadcast.
        assert (
            TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count()
            == pre_arming_count
        )
        assert "task_dates_updated" not in _event_types(broadcast_mock)

        # Not suppressed: cpm_complete still fires, and echoes the resolved date.
        cpm_complete_payload = _payload_for(broadcast_mock, "cpm_complete")
        assert cpm_complete_payload["status_date"] == _FROZEN_TODAY.isoformat()

        # The one-shot flag is now set, so the project never arms again.
        project.refresh_from_db()
        assert project.status_date_floor_armed_at is not None

    def test_second_recalculation_after_arming_reports_movement_normally(
        self, project: Project, chain: tuple[Task, Task, Task]
    ) -> None:
        """Once armed, a further genuine schedule change is reported as ordinary
        movement — the suppression is one-shot, not a permanent carve-out."""
        a, _, _ = chain
        _run(str(project.pk))
        Project.objects.filter(pk=project.pk).update(status_date_floor_armed_at=None)

        # Arming run: lengthen A so there is real movement to (not) report.
        Task.objects.filter(pk=a.pk).update(duration=6)
        _run(str(project.pk))
        armed_count = TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count()

        # Second recalculation, also with real movement: reported normally.
        Task.objects.filter(pk=a.pk).update(duration=9)
        broadcast_mock, _ = _run(str(project.pk))

        assert TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count() > armed_count
        assert "task_dates_updated" in _event_types(broadcast_mock)

    def test_project_with_explicit_status_date_never_treated_as_arming(
        self, project: Project, chain: tuple[Task, Task, Task]
    ) -> None:
        """A project that already carries an explicit status_date was already
        floored before this change — its recalculations are ordinary from the
        first one, and the armed flag is never touched."""
        project.status_date = date(2026, 1, 10)
        project.save(update_fields=["status_date"])
        a, _, _ = chain

        _run(str(project.pk))
        Task.objects.filter(pk=a.pk).update(duration=6)
        broadcast_mock, _ = _run(str(project.pk))

        assert "task_dates_updated" in _event_types(broadcast_mock)
        assert TaskActivityEvent.objects.filter(event_type="cpm_recalculated").exists()
        project.refresh_from_db()
        assert project.status_date_floor_armed_at is None

    def test_brand_new_projects_first_ever_pass_is_not_treated_as_arming(
        self, project: Project, chain: tuple[Task, Task, Task]
    ) -> None:
        """A project's very first CPM pass transitions every task from null to
        computed — the same as it always has, floor or no floor — so it is not
        the "someone moved my schedule" confusion §7 guards against, and is
        reported normally. This is a regression guard for
        test_schedule_shift_emit.py's existing null -> computed coverage."""
        broadcast_mock, _ = _run(str(project.pk))

        assert "task_dates_updated" in _event_types(broadcast_mock)
        assert TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count() == 3
        # The flag is still armed by this pass, so a *later* null-status_date
        # recalculation on this project is never treated as arming again.
        project.refresh_from_db()
        assert project.status_date_floor_armed_at is not None

    def test_resolved_status_date_echoed_on_tracker_result(
        self, project: Project, chain: tuple[Task, Task, Task]
    ) -> None:
        """The result handed to TaskRunTracker.set_result (persisted as
        TaskRun.result_summary and read back by the SchedulerRunResultSummarySerializer)
        carries the resolved status_date — a REST client polling after the fact
        (rather than catching the live broadcast) still gets provenance."""
        tracker = MagicMock()
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        ):
            _run_schedule(str(project.pk), tracker)

        tracker.set_result.assert_called_once()
        (result,), _kwargs = tracker.set_result.call_args
        assert result["status_date"] == _FROZEN_TODAY.isoformat()
