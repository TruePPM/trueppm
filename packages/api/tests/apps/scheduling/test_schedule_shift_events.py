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


def _task(**dates: Any) -> SimpleNamespace:
    """A stand-in Task carrying only the fields the builder reads."""
    return SimpleNamespace(
        id=uuid.uuid4(),
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
