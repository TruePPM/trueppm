"""Unit tests for the CPM schedule-shift event builder (ADR-0207, #1604).

These exercise the pure moved-detection and baseline-drift crossing logic of
``_build_schedule_shift_events`` without a database or a full CPM run: it only
reads the in-memory Task date fields and returns unsaved ``TaskActivityEvent``
instances, so the assertions are on the returned objects' attributes.
"""

from __future__ import annotations

import uuid
from datetime import date
from types import SimpleNamespace
from typing import Any

from trueppm_api.apps.scheduling.tasks import _build_schedule_shift_events

_DEFAULT_PROJECT = uuid.uuid4()


def _task(**dates: Any) -> SimpleNamespace:
    """A stand-in Task carrying only the fields the builder reads."""
    return SimpleNamespace(
        id=uuid.uuid4(),
        project_id=dates.get("project_id", _DEFAULT_PROJECT),
        early_start=dates.get("early_start"),
        early_finish=dates.get("early_finish"),
        late_start=dates.get("late_start"),
        late_finish=dates.get("late_finish"),
        total_float=dates.get("total_float", 0),
        is_critical=dates.get("is_critical", False),
    )


def test_cpm_recalculated_only_for_moved_tasks() -> None:
    moved = _task(early_start=date(2026, 1, 3), early_finish=date(2026, 1, 8))
    unmoved = _task(early_start=date(2026, 1, 1), early_finish=date(2026, 1, 5))
    old_dates = {
        # moved: early_start shifted 1/1 -> 1/3
        str(moved.id): (date(2026, 1, 1), date(2026, 1, 5), None, None),
        # unmoved: identical before/after
        str(unmoved.id): (date(2026, 1, 1), date(2026, 1, 5), None, None),
    }
    events = _build_schedule_shift_events([moved, unmoved], old_dates, {})
    kinds = [(e.task_id, e.event_type) for e in events]
    assert (moved.id, "cpm_recalculated") in kinds
    assert all(tid != unmoved.id for tid, _ in kinds)
    # System events carry a null actor and record the from/to delta.
    cpm = next(e for e in events if e.task_id == moved.id)
    assert cpm.actor is None
    assert cpm.detail["early_start"] == {"from": "2026-01-01", "to": "2026-01-03"}


def test_baseline_drift_emitted_only_on_crossing() -> None:
    baseline_finish = date(2026, 1, 10)
    crossing = _task(early_finish=date(2026, 1, 15))  # was within, now past
    already = _task(early_finish=date(2026, 1, 25))  # was past, still past
    never = _task(early_finish=date(2026, 1, 5))  # within, still within
    old_dates = {
        str(crossing.id): (None, date(2026, 1, 8), None, None),
        str(already.id): (None, date(2026, 1, 20), None, None),
        str(never.id): (None, date(2026, 1, 4), None, None),
    }
    baseline = {
        str(crossing.id): ("b1", baseline_finish),
        str(already.id): ("b1", baseline_finish),
        str(never.id): ("b1", baseline_finish),
    }
    events = _build_schedule_shift_events([crossing, already, never], old_dates, baseline)
    drift = [e for e in events if e.event_type == "baseline_drift_detected"]
    assert [e.task_id for e in drift] == [crossing.id]
    assert drift[0].actor is None
    assert drift[0].detail["drift_days"] == 5
    assert drift[0].detail["baseline_id"] == "b1"


def test_task_absent_from_old_dates_is_skipped() -> None:
    orphan = _task(early_start=date(2026, 1, 3))
    events = _build_schedule_shift_events([orphan], {}, {})
    assert events == []


# ---------------------------------------------------------------------------
# Per-project recalc summary (#1948)
# ---------------------------------------------------------------------------


def test_recalc_summary_counts_moved_and_reports_finish_slip() -> None:
    """Slip case: finish moves later -> positive delta; count excludes unmoved."""
    moved1 = _task(early_start=date(2026, 1, 3), early_finish=date(2026, 1, 8))
    moved2 = _task(early_start=date(2026, 1, 5), early_finish=date(2026, 1, 12))
    unmoved = _task(early_start=date(2026, 1, 1), early_finish=date(2026, 1, 5))
    old_dates = {
        # both moved: prior finishes 1/5 and 1/9; latest prior finish = 1/9
        str(moved1.id): (date(2026, 1, 1), date(2026, 1, 5), None, None),
        str(moved2.id): (date(2026, 1, 2), date(2026, 1, 9), None, None),
        str(unmoved.id): (date(2026, 1, 1), date(2026, 1, 5), None, None),
    }
    events = _build_schedule_shift_events([moved1, moved2, unmoved], old_dates, {})
    cpm = [e for e in events if e.event_type == "cpm_recalculated"]
    assert len(cpm) == 2  # only the two moved tasks
    for e in cpm:
        assert e.detail["recalc_moved_count"] == 2
        # New latest finish is 1/12 (moved2); prior latest was 1/9 -> +3 slip.
        assert e.detail["recalc_finish"] == "2026-01-12"
        assert e.detail["recalc_finish_delta_days"] == 3
        # Existing keys retained for back-compat.
        assert "early_finish" in e.detail
        assert "is_critical" in e.detail


def test_recalc_summary_reports_pull_in_as_negative_delta() -> None:
    moved = _task(early_start=date(2026, 1, 1), early_finish=date(2026, 1, 6))
    old_dates = {
        # finish pulled in from 1/10 to 1/6 -> -4
        str(moved.id): (date(2026, 1, 1), date(2026, 1, 10), None, None),
    }
    events = _build_schedule_shift_events([moved], old_dates, {})
    cpm = next(e for e in events if e.event_type == "cpm_recalculated")
    assert cpm.detail["recalc_finish_delta_days"] == -4
    assert cpm.detail["recalc_finish"] == "2026-01-06"


def test_recalc_summary_zero_delta_when_finish_unchanged() -> None:
    # A task moves on early_start but its (project-max) finish is unchanged.
    moved = _task(early_start=date(2026, 1, 3), early_finish=date(2026, 1, 8))
    old_dates = {
        str(moved.id): (date(2026, 1, 1), date(2026, 1, 8), None, None),
    }
    events = _build_schedule_shift_events([moved], old_dates, {})
    cpm = next(e for e in events if e.event_type == "cpm_recalculated")
    assert cpm.detail["recalc_finish_delta_days"] == 0


def test_recalc_summary_first_recalc_has_null_delta_but_finish_set() -> None:
    """First-ever recalc: all prior early_finish are None -> delta None, finish set."""
    t1 = _task(early_start=date(2026, 1, 3), early_finish=date(2026, 1, 8))
    t2 = _task(early_start=date(2026, 1, 5), early_finish=date(2026, 1, 12))
    old_dates = {
        str(t1.id): (None, None, None, None),
        str(t2.id): (None, None, None, None),
    }
    events = _build_schedule_shift_events([t1, t2], old_dates, {})
    cpm = [e for e in events if e.event_type == "cpm_recalculated"]
    assert len(cpm) == 2
    for e in cpm:
        assert e.detail["recalc_moved_count"] == 2
        assert e.detail["recalc_finish"] == "2026-01-12"  # latest early_finish
        assert e.detail["recalc_finish_delta_days"] is None


def test_recalc_summary_is_scoped_per_project_in_program_pass() -> None:
    """MANDATORY (#1948): a shared program-scoped call must never leak a
    program-wide count/finish onto another member project's row.

    Two member projects both move in ONE ``_build_schedule_shift_events`` call.
    Project A's rows must carry A's count and A's finish only — never the
    combined total — or the OSS project-isolation boundary is violated.
    """
    project_a = uuid.uuid4()
    project_b = uuid.uuid4()
    # Project A: two moved tasks, latest finish 1/8.
    a1 = _task(project_id=project_a, early_start=date(2026, 1, 3), early_finish=date(2026, 1, 6))
    a2 = _task(project_id=project_a, early_start=date(2026, 1, 4), early_finish=date(2026, 1, 8))
    # Project B: three moved tasks, latest finish 1/20.
    b1 = _task(project_id=project_b, early_start=date(2026, 2, 1), early_finish=date(2026, 2, 4))
    b2 = _task(project_id=project_b, early_start=date(2026, 2, 2), early_finish=date(2026, 2, 6))
    b3 = _task(project_id=project_b, early_start=date(2026, 2, 3), early_finish=date(2026, 1, 20))
    old_dates = {
        str(a1.id): (date(2026, 1, 1), date(2026, 1, 4), None, None),
        str(a2.id): (date(2026, 1, 1), date(2026, 1, 5), None, None),
        str(b1.id): (date(2026, 1, 25), date(2026, 1, 28), None, None),
        str(b2.id): (date(2026, 1, 26), date(2026, 1, 29), None, None),
        str(b3.id): (date(2026, 1, 27), date(2026, 1, 30), None, None),
    }
    events = _build_schedule_shift_events([a1, a2, b1, b2, b3], old_dates, {})
    by_task = {e.task_id: e for e in events if e.event_type == "cpm_recalculated"}

    for tid in (a1.id, a2.id):
        assert by_task[tid].detail["recalc_moved_count"] == 2, "A must not see B's tasks"
        assert by_task[tid].detail["recalc_finish"] == "2026-01-08"
    for tid in (b1.id, b2.id, b3.id):
        assert by_task[tid].detail["recalc_moved_count"] == 3, "B must not see A's tasks"
        assert by_task[tid].detail["recalc_finish"] == "2026-02-06"
