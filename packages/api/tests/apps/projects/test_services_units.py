"""Unit coverage for the projects service-layer helpers (#2459).

``apps/projects/services.py`` is reached almost entirely through viewsets and the
sprint-close Celery task, so its *endpoint-visible* behavior is well covered while
the pure computational helpers underneath keep whole branches unexecuted: the
degenerate inputs (empty name, zero-capacity window, no velocity band), the error
paths (invalid chart type, reversed window), and the "other side" of every band
threshold.

The helpers exercised here are pure functions of their arguments — the same call
the service layer makes, minus a Postgres round trip. Value holders are built with
``SimpleNamespace``/plain dicts, exactly the shapes the callers pass; nothing is
persisted, so these run without the database on purpose. The handful of cases that
genuinely need rows (the project-start auto-shift, the WIP-breach counts, the
throughput-vs-velocity router) carry ``@pytest.mark.django_db``.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    AggregationPolicy,
    Baseline,
    BaselineTask,
    Calendar,
    DeliveryMode,
    ExportJobStatus,
    Methodology,
    Program,
    ProgramExportJob,
    Project,
    ProjectExportJob,
    RollupKpi,
    ScopeChangeStatus,
    Sprint,
    SprintScopeChange,
    SprintState,
    SprintTaskDisposition,
    SprintTaskOutcome,
    Task,
    TaskDurationChangeEvent,
    TaskRecurrenceFrequency,
    TaskStatus,
    Visibility,
)
from trueppm_api.apps.projects.services import (
    DemoReorderConflict,
    MilestoneBindingError,
    MilestoneNotFound,
    QueueReorderConflict,
    QueueReorderValidation,
    ScopeAcceptForbidden,
    SprintAlreadyBound,
    _apply_ideal_curve,
    _assemble_milestone_rollup,
    _baseline_planned_series,
    _capacity_label,
    _capacity_summary_from_rows,
    _collect_history_deltas,
    _completion_rows,
    _daily_burn_series,
    _date_range_inclusive,
    _fold_status,
    _forecast_confidence,
    _history_is_flagged,
    _initials,
    _new_blocker_entry,
    _occurrence_matches,
    _prefers_throughput_forecast,
    _sample_backlog_sprint_counts,
    _sample_throughput_counts,
    _sprint_load,
    _sprint_rollup_aggregates,
    _status_move_entry,
    _typical_sprint_length_days,
    _velocity_band_percentiles,
    _weekly_throughput,
    _working_days,
    annotate_wip_breach,
    apply_program_defaults,
    apply_settings_template,
    batch_compute_milestone_rollups,
    burn_series,
    capacity_summaries_for_sprints,
    capacity_summary,
    compute_scope_rollup,
    compute_sprint_burn_status,
    enqueue_program_export,
    enqueue_project_export,
    incoming_carryover,
    list_project_milestones,
    notify_carryover_assignees,
    notify_sprint_membership_change,
    pending_scope_advisory,
    rollup_config_defaults,
    scheduler_velocity_inputs,
    shift_project_start_if_needed,
    sprint_duration_change_payload,
    sprint_pending_count,
    sprint_scope_change_payload,
    working_day_duration,
)

# 2026-01-05 is a Monday — every weekday-sensitive fixture below anchors here so
# the bitmask arithmetic is readable rather than incidental.
MONDAY = date(2026, 1, 5)


def _dt(d: date, hour: int = 12) -> datetime:
    """A timezone-aware datetime inside ``d`` (history rows are datetimes)."""
    return datetime.combine(d, datetime.min.time(), tzinfo=timezone.get_current_timezone()).replace(
        hour=hour
    )


# ---------------------------------------------------------------------------
# rollup_config_defaults — methodology-aware program seeding (ADR-0169)
# ---------------------------------------------------------------------------


class TestRollupConfigDefaults:
    def test_waterfall_returns_the_schedule_kpi_set(self) -> None:
        """WATERFALL seeds the six schedule/cost KPIs, worst-first aggregation."""
        kpis, policy = rollup_config_defaults(Methodology.WATERFALL)
        assert kpis == [
            RollupKpi.SCHEDULE_HEALTH.value,
            RollupKpi.BASELINE_VARIANCE.value,
            RollupKpi.CRITICAL_TASKS.value,
            RollupKpi.MILESTONE_HEALTH.value,
            RollupKpi.BUDGET_UTILIZATION.value,
            RollupKpi.COST_VARIANCE.value,
        ]
        assert policy == AggregationPolicy.WORST.value

    def test_agile_returns_the_delivery_kpi_set(self) -> None:
        """AGILE seeds the four delivery/risk KPIs — no baseline or cost variance."""
        kpis, policy = rollup_config_defaults(Methodology.AGILE)
        assert kpis == [
            RollupKpi.MILESTONE_HEALTH.value,
            RollupKpi.P80_COMPLETION.value,
            RollupKpi.AT_RISK_TASKS.value,
            RollupKpi.RISK_SCORE.value,
        ]
        assert policy == AggregationPolicy.WORST.value

    def test_hybrid_returns_the_deduplicated_union_in_waterfall_order(self) -> None:
        """HYBRID unions both sets, dropping the MILESTONE_HEALTH duplicate."""
        kpis, _policy = rollup_config_defaults(Methodology.HYBRID)
        assert len(kpis) == len(set(kpis)) == 9
        assert kpis[0] == RollupKpi.SCHEDULE_HEALTH.value
        assert kpis.count(RollupKpi.MILESTONE_HEALTH.value) == 1

    def test_unknown_methodology_falls_back_to_the_hybrid_union(self) -> None:
        """An unexpected stored value degrades to the union, never to an empty set."""
        assert rollup_config_defaults("SOMETHING_ELSE") == rollup_config_defaults(
            Methodology.HYBRID
        )


# ---------------------------------------------------------------------------
# Working-day arithmetic
# ---------------------------------------------------------------------------


class TestWorkingDays:
    def test_default_mask_counts_only_weekdays(self) -> None:
        """Mon–Fri mask (31) counts 5 of the 7 days in a full week."""
        assert _working_days(MONDAY, MONDAY + timedelta(days=6)) == 5

    def test_seven_day_mask_counts_every_day(self) -> None:
        assert _working_days(MONDAY, MONDAY + timedelta(days=6), 127) == 7

    def test_weekend_only_mask_counts_only_the_weekend(self) -> None:
        """Sat=32 | Sun=64 — the inverse of the default mask."""
        assert _working_days(MONDAY, MONDAY + timedelta(days=6), 32 | 64) == 2

    def test_single_working_day_window_counts_one(self) -> None:
        assert _working_days(MONDAY, MONDAY) == 1

    def test_reversed_window_counts_zero(self) -> None:
        """finish < start yields no iterations rather than an error."""
        assert _working_days(MONDAY + timedelta(days=1), MONDAY) == 0

    def test_date_max_terminates_instead_of_overflowing(self) -> None:
        """The final-increment guard stops at date.max rather than raising OverflowError."""
        assert _working_days(date.max, date.max, 127) == 1

    def test_working_day_duration_uses_the_calendar_mask(self) -> None:
        """A 7-day calendar counts the weekend; the same window on Mon–Fri does not."""
        seven_day = SimpleNamespace(working_days=127)
        assert working_day_duration(MONDAY, MONDAY + timedelta(days=6), seven_day) == 7

    def test_working_day_duration_defaults_to_mon_fri_without_a_calendar(self) -> None:
        assert working_day_duration(MONDAY, MONDAY + timedelta(days=6), None) == 5


# ---------------------------------------------------------------------------
# Capacity math
# ---------------------------------------------------------------------------


class TestInitials:
    def test_two_word_name_uses_first_and_last_initial(self) -> None:
        assert _initials("Priya Raman") == "PR"

    def test_three_word_name_skips_the_middle_name(self) -> None:
        assert _initials("Ada Byron Lovelace") == "AL"

    def test_single_word_name_uses_its_first_two_letters(self) -> None:
        assert _initials("morgan") == "MO"

    def test_blank_name_falls_back_to_a_question_mark(self) -> None:
        """An unnamed resource must not crash the capacity payload."""
        assert _initials("   ") == "?"


class TestCapacityLabel:
    @pytest.mark.parametrize(
        ("ratio", "expected"),
        [
            (1.01, "over_capacity"),
            (1.0, "at_risk"),
            (0.9, "at_risk"),
            (0.89, "on_track"),
            (0.0, "on_track"),
        ],
    )
    def test_band_thresholds(self, ratio: float, expected: str) -> None:
        """Both sides of each band boundary — 1.0 is at_risk, not over_capacity."""
        assert _capacity_label(ratio) == expected


def _sprint_ns(start: date, finish: date, *, calendar: Any = None) -> SimpleNamespace:
    return SimpleNamespace(
        pk=uuid.uuid4(),
        start_date=start,
        finish_date=finish,
        project=SimpleNamespace(calendar=calendar),
    )


class TestCapacitySummaryFromRows:
    def test_zero_working_day_window_returns_the_empty_totals_shape(self) -> None:
        """A weekend-only sprint on a Mon–Fri calendar has no capacity at all."""
        saturday = date(2026, 1, 10)
        sprint = _sprint_ns(saturday, saturday + timedelta(days=1))
        summary = _capacity_summary_from_rows(sprint, [])
        assert summary["working_days"] == 0
        assert summary["members"] == []
        assert summary["totals"]["available_hours"] == 0.0
        assert summary["totals"]["label"] == "on_track"
        assert summary["hours_per_day"] == 8.0

    def test_full_allocation_reports_on_track_and_no_over_flag(self) -> None:
        """5 working days × 1.0 units × 8 h = exactly the member's availability."""
        sprint = _sprint_ns(MONDAY, MONDAY + timedelta(days=4))
        rid = uuid.uuid4()
        rows = [(rid, "Priya Raman", Decimal("1.0"), Decimal("1.0"), MONDAY, MONDAY + timedelta(4))]
        summary = _capacity_summary_from_rows(sprint, rows)
        member = summary["members"][0]
        assert member["committed_hours"] == 40.0
        assert member["available_hours"] == 40.0
        assert member["is_over"] is False
        assert member["initials"] == "PR"
        assert summary["totals"]["ratio"] == 1.0
        assert summary["totals"]["buffer_hours"] == 0.0

    def test_double_booked_member_is_flagged_over_capacity(self) -> None:
        """Two full-time assignments in one window overshoot the same availability."""
        sprint = _sprint_ns(MONDAY, MONDAY + timedelta(days=4))
        rid = uuid.uuid4()
        row = (rid, "Sam Lee", Decimal("1.0"), Decimal("1.0"), MONDAY, MONDAY + timedelta(4))
        summary = _capacity_summary_from_rows(sprint, [row, row])
        member = summary["members"][0]
        assert member["committed_hours"] == 80.0
        assert member["available_hours"] == 40.0
        assert member["is_over"] is True
        assert summary["totals"]["label"] == "over_capacity"
        assert summary["totals"]["buffer_hours"] == -40.0

    def test_task_window_outside_the_sprint_contributes_nothing(self) -> None:
        """A task that finishes before the sprint opens has zero overlap, not negative."""
        sprint = _sprint_ns(MONDAY, MONDAY + timedelta(days=4))
        rows = [
            (
                uuid.uuid4(),
                "Out Of Window",
                Decimal("1.0"),
                Decimal("1.0"),
                MONDAY - timedelta(days=20),
                MONDAY - timedelta(days=16),
            )
        ]
        summary = _capacity_summary_from_rows(sprint, rows)
        assert summary["members"][0]["committed_hours"] == 0.0
        assert summary["totals"]["ratio"] == 0.0

    def test_null_task_dates_fall_back_to_the_full_sprint_window(self) -> None:
        """Before CPM runs a task has no dates — it still books the whole sprint."""
        sprint = _sprint_ns(MONDAY, MONDAY + timedelta(days=4))
        rows = [(uuid.uuid4(), "No Dates", None, Decimal("1.0"), None, None)]
        summary = _capacity_summary_from_rows(sprint, rows)
        assert summary["members"][0]["committed_hours"] == 40.0
        # max_units NULL falls back to 1.0, so availability matches the commitment.
        assert summary["members"][0]["available_hours"] == 40.0

    def test_members_are_sorted_by_name(self) -> None:
        sprint = _sprint_ns(MONDAY, MONDAY + timedelta(days=4))
        rows = [
            (uuid.uuid4(), "Zoe", Decimal("1.0"), Decimal("0.5"), MONDAY, MONDAY),
            (uuid.uuid4(), "Adam", Decimal("1.0"), Decimal("0.5"), MONDAY, MONDAY),
        ]
        summary = _capacity_summary_from_rows(sprint, rows)
        assert [m["member_name"] for m in summary["members"]] == ["Adam", "Zoe"]

    def test_calendar_hours_per_day_and_mask_are_honored(self) -> None:
        """A 7-day, 6-hour calendar changes both the divisor and the day count."""
        cal = SimpleNamespace(working_days=127, hours_per_day=Decimal("6.0"))
        sprint = _sprint_ns(MONDAY, MONDAY + timedelta(days=6), calendar=cal)
        summary = _capacity_summary_from_rows(sprint, [])
        assert summary["working_days"] == 7
        assert summary["hours_per_day"] == 6.0


class TestCapacitySummariesForSprints:
    def test_empty_sprint_list_returns_an_empty_map(self) -> None:
        """No sprints means no TaskResource query and no rows to dispatch."""
        assert capacity_summaries_for_sprints([]) == {}


# ---------------------------------------------------------------------------
# Burn series helpers
# ---------------------------------------------------------------------------


class TestDateRangeInclusive:
    def test_inclusive_of_both_endpoints(self) -> None:
        days = _date_range_inclusive(MONDAY, MONDAY + timedelta(days=2))
        assert days == [MONDAY, MONDAY + timedelta(days=1), MONDAY + timedelta(days=2)]

    def test_single_day_window(self) -> None:
        assert _date_range_inclusive(MONDAY, MONDAY) == [MONDAY]

    def test_reversed_window_is_empty(self) -> None:
        assert _date_range_inclusive(MONDAY + timedelta(days=1), MONDAY) == []


class TestApplyIdealCurve:
    def test_burndown_anchors_to_the_first_day_scope_and_reaches_zero(self) -> None:
        series = [{"scope": 10}, {"scope": 12}, {"scope": 12}]
        _apply_ideal_curve(series, chart_type="burndown", day_count=3)
        assert [p["ideal"] for p in series] == [10.0, 5.0, 0.0]

    def test_burnup_anchors_to_the_final_day_scope_and_starts_at_zero(self) -> None:
        series = [{"scope": 10}, {"scope": 12}, {"scope": 12}]
        _apply_ideal_curve(series, chart_type="burnup", day_count=3)
        assert [p["ideal"] for p in series] == [0.0, 6.0, 12.0]

    def test_single_day_series_does_not_divide_by_zero(self) -> None:
        """day_count 1 clamps the span to 1 so progress is 0 for the only point."""
        series = [{"scope": 8}]
        _apply_ideal_curve(series, chart_type="burndown", day_count=1)
        assert series[0]["ideal"] == 8.0

    def test_empty_series_is_a_no_op(self) -> None:
        series: list[dict[str, Any]] = []
        _apply_ideal_curve(series, chart_type="burnup", day_count=0)
        assert series == []


class TestDailyBurnSeries:
    def _rows(self, day: date, status: str, points: int | None) -> list[dict[str, Any]]:
        return [
            {
                "history_date": _dt(day),
                "history_type": "+",
                "status": status,
                "story_points": points,
                "is_deleted": False,
            }
        ]

    def test_points_metric_sums_story_points_and_burns_down(self) -> None:
        by_task = {
            "a": self._rows(MONDAY, TaskStatus.NOT_STARTED, 5),
            "b": self._rows(MONDAY, TaskStatus.COMPLETE, 3),
        }
        series = _daily_burn_series(by_task, [MONDAY], chart_type="burndown", metric="points")
        assert series == [{"date": MONDAY.isoformat(), "scope": 8, "actual": 5}]

    def test_tasks_metric_counts_rows_and_burns_up(self) -> None:
        by_task = {
            "a": self._rows(MONDAY, TaskStatus.NOT_STARTED, 5),
            "b": self._rows(MONDAY, TaskStatus.COMPLETE, 3),
        }
        series = _daily_burn_series(by_task, [MONDAY], chart_type="burnup", metric="tasks")
        assert series == [{"date": MONDAY.isoformat(), "scope": 2, "actual": 1}]

    def test_task_created_after_the_day_contributes_nothing(self) -> None:
        """A task with no state on or before the day is absent, not zero-valued."""
        by_task = {"a": self._rows(MONDAY + timedelta(days=3), TaskStatus.NOT_STARTED, 5)}
        series = _daily_burn_series(by_task, [MONDAY], chart_type="burndown", metric="points")
        assert series[0]["scope"] == 0

    def test_deleted_and_hard_deleted_rows_are_excluded(self) -> None:
        rows = self._rows(MONDAY, TaskStatus.NOT_STARTED, 5)
        rows[0]["is_deleted"] = True
        tombstone = self._rows(MONDAY, TaskStatus.NOT_STARTED, 7)
        tombstone[0]["history_type"] = "-"
        series = _daily_burn_series(
            {"a": rows, "b": tombstone}, [MONDAY], chart_type="burndown", metric="points"
        )
        assert series[0]["scope"] == 0

    def test_null_story_points_contribute_zero_on_the_points_metric(self) -> None:
        by_task = {"a": self._rows(MONDAY, TaskStatus.NOT_STARTED, None)}
        series = _daily_burn_series(by_task, [MONDAY], chart_type="burndown", metric="points")
        assert series[0]["scope"] == 0


class TestBaselinePlannedSeries:
    def test_burndown_draws_the_outstanding_baselined_weight_down(self) -> None:
        weights = {"t1": 3, "t2": 5}
        finishes = [("t1", MONDAY), ("t2", MONDAY + timedelta(days=2))]
        days = _date_range_inclusive(MONDAY, MONDAY + timedelta(days=2))
        out = _baseline_planned_series(weights, finishes, days, chart_type="burndown")
        assert [p["planned"] for p in out] == [5, 5, 0]

    def test_burnup_accumulates_the_same_weight(self) -> None:
        weights = {"t1": 3, "t2": 5}
        finishes = [("t1", MONDAY), ("t2", MONDAY + timedelta(days=2))]
        days = _date_range_inclusive(MONDAY, MONDAY + timedelta(days=2))
        out = _baseline_planned_series(weights, finishes, days, chart_type="burnup")
        assert [p["planned"] for p in out] == [3, 3, 8]

    def test_undated_baseline_row_never_counts_as_done(self) -> None:
        """A baselined task with no snapshot finish stays outstanding all window."""
        out = _baseline_planned_series({"t1": 4}, [("t1", None)], [MONDAY], chart_type="burndown")
        assert out[0]["planned"] == 4


class TestBurnSeriesArgumentValidation:
    def test_unknown_chart_type_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="Invalid chart_type"):
            burn_series(uuid.uuid4(), chart_type="sideways", since=MONDAY, until=MONDAY)

    def test_unknown_metric_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="Invalid metric"):
            burn_series(
                uuid.uuid4(), chart_type="burndown", since=MONDAY, until=MONDAY, metric="hours"
            )

    def test_reversed_window_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="must be on or after"):
            burn_series(
                uuid.uuid4(),
                chart_type="burndown",
                since=MONDAY + timedelta(days=1),
                until=MONDAY,
            )


# ---------------------------------------------------------------------------
# compute_sprint_burn_status — the pace verdict
# ---------------------------------------------------------------------------


def _burn_sprint(committed: int | None) -> SimpleNamespace:
    """A 10-day sprint whose midpoint is today, so the ideal line is at 50%."""
    today = timezone.localdate()
    return SimpleNamespace(
        committed_points=committed,
        start_date=today - timedelta(days=4),
        finish_date=today + timedelta(days=5),
    )


class TestComputeSprintBurnStatus:
    def test_no_points_commitment_is_no_data(self) -> None:
        result = compute_sprint_burn_status(_burn_sprint(0), [SimpleNamespace(remaining_points=10)])
        assert result == {
            "burn_status": "no_data",
            "trend_points": None,
            "projected_finish_date": None,
        }

    def test_no_snapshots_is_no_data(self) -> None:
        assert compute_sprint_burn_status(_burn_sprint(100), [])["burn_status"] == "no_data"

    def test_well_under_the_ideal_line_reads_ahead(self) -> None:
        result = compute_sprint_burn_status(
            _burn_sprint(100), [SimpleNamespace(remaining_points=10)]
        )
        assert result["burn_status"] == "ahead"
        assert result["trend_points"] == 40
        assert (
            result["projected_finish_date"]
            == (timezone.localdate() + timedelta(days=1)).isoformat()
        )

    def test_well_over_the_ideal_line_reads_behind(self) -> None:
        result = compute_sprint_burn_status(
            _burn_sprint(100), [SimpleNamespace(remaining_points=90)]
        )
        assert result["burn_status"] == "behind"
        assert result["trend_points"] == -40

    def test_on_the_ideal_line_reads_on_track(self) -> None:
        result = compute_sprint_burn_status(
            _burn_sprint(100), [SimpleNamespace(remaining_points=50)]
        )
        assert result["burn_status"] == "on_track"
        assert result["trend_points"] == 0

    def test_finished_sprint_has_no_projected_finish(self) -> None:
        """Zero remaining leaves nothing to forecast, so the date is omitted."""
        result = compute_sprint_burn_status(
            _burn_sprint(100), [SimpleNamespace(remaining_points=0)]
        )
        assert result["projected_finish_date"] is None

    def test_no_burn_yet_leaves_the_projection_null(self) -> None:
        """remaining == committed means a zero burn rate — no defensible forecast."""
        result = compute_sprint_burn_status(
            _burn_sprint(100), [SimpleNamespace(remaining_points=100)]
        )
        assert result["burn_status"] == "behind"
        assert result["projected_finish_date"] is None

    def test_only_the_last_snapshot_drives_the_verdict(self) -> None:
        snapshots = [
            SimpleNamespace(remaining_points=100),
            SimpleNamespace(remaining_points=10),
        ]
        assert compute_sprint_burn_status(_burn_sprint(100), snapshots)["burn_status"] == "ahead"


# ---------------------------------------------------------------------------
# Standup delta helpers (ADR-0121 / ADR-0124)
# ---------------------------------------------------------------------------


class TestHistoryFlagHelpers:
    def test_non_empty_blocked_reason_is_flagged(self) -> None:
        assert _history_is_flagged(SimpleNamespace(blocked_reason="waiting on vendor")) is True

    def test_whitespace_only_blocked_reason_is_not_flagged(self) -> None:
        assert _history_is_flagged(SimpleNamespace(blocked_reason="   ")) is False

    def test_missing_attribute_is_not_flagged(self) -> None:
        assert _history_is_flagged(SimpleNamespace()) is False

    def test_status_move_entry_records_both_endpoints_and_the_actor(self) -> None:
        row = SimpleNamespace(
            id=uuid.uuid4(),
            name="Ship it",
            status=TaskStatus.COMPLETE,
            history_date=_dt(MONDAY),
        )
        actor = SimpleNamespace(pk=7, username="priya")
        prev = SimpleNamespace(status=TaskStatus.IN_PROGRESS)
        entry = _status_move_entry(row, prev, "T-1A", actor)
        assert entry["kind"] == "status"
        assert entry["from"] == TaskStatus.IN_PROGRESS
        assert entry["to"] == TaskStatus.COMPLETE
        assert entry["actor_id"] == 7
        assert entry["actor_username"] == "priya"
        assert entry["task_short_id"] == "T-1A"

    def test_status_move_entry_tolerates_a_system_actor(self) -> None:
        """A history row written by a background job carries no user."""
        row = SimpleNamespace(
            id=uuid.uuid4(), name="T", status="COMPLETE", history_date=_dt(MONDAY)
        )
        entry = _status_move_entry(row, SimpleNamespace(status="REVIEW"), "", None)
        assert entry["actor_id"] is None
        assert entry["actor_username"] is None

    def test_blocker_entry_with_a_type_is_an_impediment_and_carries_age(self) -> None:
        until = _dt(MONDAY, hour=12)
        row = SimpleNamespace(
            id=uuid.uuid4(),
            name="Blocked task",
            history_date=until,
            blocked_since=until - timedelta(hours=2),
            blocker_type="external_vendor",
        )
        entry = _new_blocker_entry(row, "T-9", SimpleNamespace(username="sam"), until)
        assert entry["kind"] == "impediment"
        assert entry["blocker_type"] == "external_vendor"
        assert entry["blocked_age_seconds"] == 7200
        # The free-text reason never leaves the server (ADR-0124).
        assert "blocked_reason" not in entry

    def test_blocker_entry_without_a_type_is_paused_with_no_age(self) -> None:
        until = _dt(MONDAY)
        row = SimpleNamespace(
            id=uuid.uuid4(),
            name="Parked",
            history_date=until,
            blocked_since=None,
            blocker_type="  ",
        )
        entry = _new_blocker_entry(row, "T-9", None, until)
        assert entry["kind"] == "paused"
        assert entry["blocker_type"] is None
        assert entry["blocked_age_seconds"] is None
        assert entry["actor_username"] is None

    def test_blocker_age_never_goes_negative(self) -> None:
        """A blocked_since stamped after the window end clamps to zero, not below."""
        until = _dt(MONDAY)
        row = SimpleNamespace(
            id=uuid.uuid4(),
            name="Clock skew",
            history_date=until,
            blocked_since=until + timedelta(hours=1),
            blocker_type="",
        )
        assert _new_blocker_entry(row, "", None, until)["blocked_age_seconds"] == 0


class TestSprintLoadPrivacyGate:
    def test_below_audience_reader_gets_every_point_figure_nulled(self) -> None:
        """ADR-0104: the standup shows counts to everyone, points only to the team."""
        sprint = SimpleNamespace(pk=uuid.uuid4(), committed_points=40, capacity_points=50)
        assert _sprint_load(sprint, velocity_readable=False) == {
            "committed_points": None,
            "current_points": None,
            "delta_points": None,
            "pct_loaded": None,
        }


# ---------------------------------------------------------------------------
# Forecast band helpers (ADR-0106)
# ---------------------------------------------------------------------------


class TestVelocityBandPercentiles:
    def test_slow_tail_penalty_spreads_p80_and_p95_after_p50(self) -> None:
        cpm = date(2026, 6, 1)
        p50, p80, p95, usable = _velocity_band_percentiles(
            cpm_finish=cpm, remaining=10, sprint_days=10, velocity_low=5, avg=10.0
        )
        assert usable is True
        assert p50 == cpm
        assert p80 == cpm + timedelta(days=6)
        assert p95 == cpm + timedelta(days=10)
        assert p50 <= p80 <= p95

    def test_missing_band_collapses_the_spread_and_reports_unusable(self) -> None:
        """Below the 2-closed-sprint floor there is no defensible range."""
        cpm = date(2026, 6, 1)
        p50, p80, p95, usable = _velocity_band_percentiles(
            cpm_finish=cpm, remaining=10, sprint_days=10, velocity_low=None, avg=None
        )
        assert (p50, p80, p95) == (cpm, cpm, cpm)
        assert usable is False

    def test_no_remaining_work_collapses_the_spread(self) -> None:
        cpm = date(2026, 6, 1)
        _p50, p80, p95, usable = _velocity_band_percentiles(
            cpm_finish=cpm, remaining=0, sprint_days=10, velocity_low=5, avg=10.0
        )
        assert (p80, p95) == (cpm, cpm)
        assert usable is False

    def test_missing_cpm_spine_collapses_the_spread(self) -> None:
        p50, p80, p95, usable = _velocity_band_percentiles(
            cpm_finish=None, remaining=10, sprint_days=10, velocity_low=5, avg=10.0
        )
        assert (p50, p80, p95) == (None, None, None)
        assert usable is False


class TestForecastConfidence:
    def test_tight_velocity_history_grades_high(self) -> None:
        assert (
            _forecast_confidence(
                usable_band=True, stdev=1.0, avg=10.0, unmodeled=False, drifted=False
            )
            == "high"
        )

    def test_moderate_variance_grades_medium(self) -> None:
        assert (
            _forecast_confidence(
                usable_band=True, stdev=3.0, avg=10.0, unmodeled=False, drifted=False
            )
            == "medium"
        )

    def test_noisy_velocity_grades_low(self) -> None:
        assert (
            _forecast_confidence(
                usable_band=True, stdev=8.0, avg=10.0, unmodeled=False, drifted=False
            )
            == "low"
        )

    def test_unusable_band_caps_at_low_regardless_of_variance(self) -> None:
        assert (
            _forecast_confidence(
                usable_band=False, stdev=0.1, avg=10.0, unmodeled=False, drifted=False
            )
            == "low"
        )

    def test_unmodeled_predecessor_caps_at_low(self) -> None:
        assert (
            _forecast_confidence(
                usable_band=True, stdev=0.1, avg=10.0, unmodeled=True, drifted=False
            )
            == "low"
        )

    def test_binding_drift_caps_at_low(self) -> None:
        assert (
            _forecast_confidence(
                usable_band=True, stdev=0.1, avg=10.0, unmodeled=False, drifted=True
            )
            == "low"
        )

    def test_absent_stdev_defaults_to_the_pessimistic_coefficient(self) -> None:
        """No stdev means cv falls back to 1.0 — never a flattering HIGH."""
        assert (
            _forecast_confidence(
                usable_band=True, stdev=None, avg=10.0, unmodeled=False, drifted=False
            )
            == "low"
        )


# ---------------------------------------------------------------------------
# Flow analytics helpers (ADR-0130)
# ---------------------------------------------------------------------------


class TestFoldStatus:
    def test_legacy_on_hold_folds_into_backlog(self) -> None:
        assert _fold_status("ON_HOLD") == "BACKLOG"

    @pytest.mark.parametrize("raw", ["BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE"])
    def test_canonical_statuses_pass_through(self, raw: str) -> None:
        assert _fold_status(raw) == raw

    def test_unknown_status_is_dropped_rather_than_bucketed(self) -> None:
        assert _fold_status("SOMETHING_ELSE") is None

    def test_null_status_is_dropped(self) -> None:
        assert _fold_status(None) is None


class TestWeeklyThroughput:
    def test_series_is_dense_and_iso_monday_anchored(self) -> None:
        """Every intersecting week gets a row, zero-filled, anchored to its Monday."""
        wednesday = MONDAY + timedelta(days=2)
        series = _weekly_throughput([], since=wednesday, until=wednesday + timedelta(days=8))
        assert [row["week_start"] for row in series] == [
            MONDAY.isoformat(),
            (MONDAY + timedelta(days=7)).isoformat(),
        ]
        assert all(row["completed_count"] == 0 for row in series)

    def test_completions_bucket_into_their_iso_week(self) -> None:
        completions = [MONDAY, MONDAY + timedelta(days=4), MONDAY + timedelta(days=7)]
        series = _weekly_throughput(completions, since=MONDAY, until=MONDAY + timedelta(days=13))
        assert [row["completed_count"] for row in series] == [2, 1]

    def test_completion_outside_the_window_is_ignored(self) -> None:
        series = _weekly_throughput(
            [MONDAY - timedelta(days=30)], since=MONDAY, until=MONDAY + timedelta(days=6)
        )
        assert series == [{"week_start": MONDAY.isoformat(), "completed_count": 0}]


class TestCompletionRows:
    def _row(self, status: str, day: date) -> dict[str, Any]:
        return {"status": status, "history_date": _dt(day)}

    def test_transition_into_complete_inside_the_window_counts_once(self) -> None:
        rows = [
            self._row("IN_PROGRESS", MONDAY),
            self._row("COMPLETE", MONDAY + timedelta(days=1)),
            self._row("COMPLETE", MONDAY + timedelta(days=2)),
        ]
        out = _completion_rows(rows, _dt(MONDAY, hour=0), _dt(MONDAY + timedelta(days=5), hour=23))
        assert len(out) == 1
        assert out[0]["history_date"] == _dt(MONDAY + timedelta(days=1))

    def test_reopened_and_recompleted_task_counts_each_transition(self) -> None:
        rows = [
            self._row("COMPLETE", MONDAY),
            self._row("IN_PROGRESS", MONDAY + timedelta(days=1)),
            self._row("COMPLETE", MONDAY + timedelta(days=2)),
        ]
        out = _completion_rows(rows, _dt(MONDAY, hour=0), _dt(MONDAY + timedelta(days=5), hour=23))
        assert len(out) == 2

    def test_transition_outside_the_window_is_not_counted(self) -> None:
        rows = [self._row("IN_PROGRESS", MONDAY), self._row("COMPLETE", MONDAY + timedelta(1))]
        out = _completion_rows(
            rows, _dt(MONDAY + timedelta(days=10), hour=0), _dt(MONDAY + timedelta(days=20))
        )
        assert out == []


class TestBootstrapSamplers:
    def test_velocity_sampler_returns_the_expected_sprint_count(self) -> None:
        """A steady 10-points-per-sprint team clears 35 points in 4 sprints."""
        counts = _sample_backlog_sprint_counts(35.0, [10.0, 10.0], runs=50, seed=1)
        assert counts is not None
        assert set(counts.tolist()) == {4.0}

    def test_velocity_sampler_returns_none_without_positive_samples(self) -> None:
        assert _sample_backlog_sprint_counts(35.0, [0.0, 0.0], runs=10, seed=1) is None

    def test_velocity_sampler_returns_none_with_no_remaining_work(self) -> None:
        assert _sample_backlog_sprint_counts(0.0, [10.0], runs=10, seed=1) is None

    def test_velocity_sampler_is_reproducible_for_a_fixed_seed(self) -> None:
        first = _sample_backlog_sprint_counts(37.0, [5.0, 15.0], runs=40, seed=99)
        second = _sample_backlog_sprint_counts(37.0, [5.0, 15.0], runs=40, seed=99)
        assert first is not None and second is not None
        assert first.tolist() == second.tolist()

    def test_throughput_sampler_returns_the_expected_week_count(self) -> None:
        import numpy as np

        counts = _sample_throughput_counts([4, 4], 12.0, 25, np.random.default_rng(3))
        assert counts is not None
        assert set(counts.tolist()) == {3.0}

    def test_throughput_sampler_returns_none_without_positive_weeks(self) -> None:
        import numpy as np

        assert _sample_throughput_counts([0, 0], 12.0, 5, np.random.default_rng(3)) is None

    def test_throughput_sampler_returns_none_with_an_empty_backlog(self) -> None:
        import numpy as np

        assert _sample_throughput_counts([4], 0.0, 5, np.random.default_rng(3)) is None


# ---------------------------------------------------------------------------
# Recurrence occurrence matching (ADR-0090)
# ---------------------------------------------------------------------------


def _rule(
    frequency: str,
    *,
    interval: int = 1,
    weekdays: int = 0,
    day_of_month: int | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        frequency=frequency, interval=interval, weekdays=weekdays, day_of_month=day_of_month
    )


class TestOccurrenceMatches:
    def test_date_before_the_anchor_never_matches(self) -> None:
        rule = _rule(TaskRecurrenceFrequency.DAILY)
        assert _occurrence_matches(rule, MONDAY, MONDAY - timedelta(days=1)) is False

    def test_daily_every_day_matches_the_anchor_and_the_next_day(self) -> None:
        rule = _rule(TaskRecurrenceFrequency.DAILY)
        assert _occurrence_matches(rule, MONDAY, MONDAY) is True
        assert _occurrence_matches(rule, MONDAY, MONDAY + timedelta(days=1)) is True

    def test_custom_every_third_day_aligns_to_the_anchor(self) -> None:
        rule = _rule(TaskRecurrenceFrequency.CUSTOM, interval=3)
        assert _occurrence_matches(rule, MONDAY, MONDAY + timedelta(days=3)) is True
        assert _occurrence_matches(rule, MONDAY, MONDAY + timedelta(days=2)) is False

    def test_zero_interval_is_clamped_to_every_period(self) -> None:
        """A corrupt interval must not raise ZeroDivisionError in the modulo."""
        rule = _rule(TaskRecurrenceFrequency.DAILY, interval=0)
        assert _occurrence_matches(rule, MONDAY, MONDAY + timedelta(days=1)) is True

    def test_weekly_matches_only_the_selected_weekdays(self) -> None:
        wednesday_only = _rule(TaskRecurrenceFrequency.WEEKLY, weekdays=1 << 2)
        assert _occurrence_matches(wednesday_only, MONDAY, MONDAY + timedelta(days=2)) is True
        assert _occurrence_matches(wednesday_only, MONDAY, MONDAY + timedelta(days=1)) is False

    def test_weekly_every_other_week_skips_the_intervening_week(self) -> None:
        rule = _rule(TaskRecurrenceFrequency.WEEKLY, interval=2, weekdays=1)
        assert _occurrence_matches(rule, MONDAY, MONDAY) is True
        assert _occurrence_matches(rule, MONDAY, MONDAY + timedelta(days=7)) is False
        assert _occurrence_matches(rule, MONDAY, MONDAY + timedelta(days=14)) is True

    def test_monthly_day_of_month_clamps_to_a_short_month(self) -> None:
        """day_of_month=31 still fires on the 28th in February."""
        rule = _rule(TaskRecurrenceFrequency.MONTHLY, day_of_month=31)
        anchor = date(2026, 1, 31)
        assert _occurrence_matches(rule, anchor, date(2026, 2, 28)) is True
        assert _occurrence_matches(rule, anchor, date(2026, 2, 27)) is False

    def test_monthly_falls_back_to_the_anchor_day_when_unset(self) -> None:
        rule = _rule(TaskRecurrenceFrequency.MONTHLY)
        anchor = date(2026, 1, 15)
        assert _occurrence_matches(rule, anchor, date(2026, 2, 15)) is True
        assert _occurrence_matches(rule, anchor, date(2026, 2, 16)) is False

    def test_monthly_every_other_month_skips_the_intervening_month(self) -> None:
        rule = _rule(TaskRecurrenceFrequency.MONTHLY, interval=2, day_of_month=15)
        anchor = date(2026, 1, 15)
        assert _occurrence_matches(rule, anchor, date(2026, 2, 15)) is False
        assert _occurrence_matches(rule, anchor, date(2026, 3, 15)) is True

    def test_unknown_frequency_never_matches(self) -> None:
        assert _occurrence_matches(_rule("YEARLY"), MONDAY, MONDAY) is False


# ---------------------------------------------------------------------------
# Copy-at-create templates (#157 / #1909)
# ---------------------------------------------------------------------------


class TestApplySettingsTemplate:
    def test_absent_fields_are_filled_from_the_source(self) -> None:
        source = Project(
            name="Source",
            start_date=MONDAY,
            timezone="Europe/Helsinki",
            stale_task_threshold_days=21,
        )
        data: dict[str, Any] = {}
        apply_settings_template(data, source)
        assert data["timezone"] == "Europe/Helsinki"
        assert data["stale_task_threshold_days"] == 21

    def test_explicit_request_value_wins_over_the_template(self) -> None:
        source = Project(name="Source", start_date=MONDAY, timezone="Europe/Helsinki")
        data: dict[str, Any] = {"timezone": "UTC"}
        apply_settings_template(data, source)
        assert data["timezone"] == "UTC"

    def test_inheriting_none_override_is_copied_as_none(self) -> None:
        """Copying the STORED value preserves inheritance (ADR-0242 §3)."""
        source = Project(name="Source", start_date=MONDAY, iteration_label=None)
        data: dict[str, Any] = {}
        apply_settings_template(data, source)
        assert data["iteration_label"] is None

    def test_list_valued_settings_are_copied_by_value(self) -> None:
        source = Project(
            name="Source", start_date=MONDAY, allowed_attachment_types=["application/pdf"]
        )
        data: dict[str, Any] = {}
        apply_settings_template(data, source)
        data["allowed_attachment_types"].append("image/png")
        assert source.allowed_attachment_types == ["application/pdf"]

    def test_returns_the_same_mapping_it_mutated(self) -> None:
        source = Project(name="Source", start_date=MONDAY)
        data: dict[str, Any] = {}
        assert apply_settings_template(data, source) is data


class TestApplyProgramDefaults:
    def test_absent_fields_are_seeded_from_the_program(self) -> None:
        program = Program(name="Prog", methodology=Methodology.AGILE, visibility=Visibility.PRIVATE)
        data: dict[str, Any] = {}
        apply_program_defaults(data, program)
        assert data["methodology"] == Methodology.AGILE
        assert data["visibility"] == Visibility.PRIVATE

    def test_explicit_request_value_wins_over_the_program_default(self) -> None:
        program = Program(name="Prog", methodology=Methodology.AGILE)
        data: dict[str, Any] = {"methodology": Methodology.WATERFALL}
        apply_program_defaults(data, program)
        assert data["methodology"] == Methodology.WATERFALL

    def test_only_the_two_program_analog_fields_are_touched(self) -> None:
        program = Program(name="Prog")
        data: dict[str, Any] = {}
        apply_program_defaults(data, program)
        assert set(data) == {"methodology", "visibility"}


# ---------------------------------------------------------------------------
# Database-backed service helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
    return Project.objects.create(name="P", start_date=MONDAY, calendar=cal)


@pytest.mark.django_db
class TestShiftProjectStartIfNeeded:
    def test_earlier_candidate_pulls_the_project_start_back(self, project: Project) -> None:
        earlier = MONDAY - timedelta(days=10)
        old_start = shift_project_start_if_needed(project, earlier)
        project.refresh_from_db()
        assert old_start == MONDAY
        assert project.start_date == earlier

    def test_later_candidate_leaves_the_project_untouched(self, project: Project) -> None:
        assert shift_project_start_if_needed(project, MONDAY + timedelta(days=10)) is None
        project.refresh_from_db()
        assert project.start_date == MONDAY

    def test_candidate_on_the_start_date_is_not_a_shift(self, project: Project) -> None:
        assert shift_project_start_if_needed(project, MONDAY) is None

    def test_absent_candidate_is_not_a_shift(self, project: Project) -> None:
        assert shift_project_start_if_needed(project, None) is None

    def test_shift_bumps_server_version_so_sync_clients_see_it(self, project: Project) -> None:
        before = project.server_version
        shift_project_start_if_needed(project, MONDAY - timedelta(days=1))
        project.refresh_from_db()
        assert project.server_version > before


@pytest.mark.django_db
class TestAnnotateWipBreach:
    def test_counts_fold_on_hold_into_backlog_and_grade_each_column(self, project: Project) -> None:
        Task.objects.create(project=project, name="B1", duration=1, status=TaskStatus.BACKLOG)
        Task.objects.create(project=project, name="H1", duration=1, status=TaskStatus.ON_HOLD)
        Task.objects.create(project=project, name="P1", duration=1, status=TaskStatus.IN_PROGRESS)
        Task.objects.create(project=project, name="P2", duration=1, status=TaskStatus.IN_PROGRESS)
        columns: list[dict[str, Any]] = [
            {"status": "BACKLOG", "wip_limit": None},
            {"status": "IN_PROGRESS", "wip_limit": 2},
            {"status": "REVIEW", "wip_limit": 1},
        ]
        by_status = {c["status"]: c for c in annotate_wip_breach(project.pk, columns)}
        # ON_HOLD folds into BACKLOG (ADR-0039), so the backlog column counts two.
        assert by_status["BACKLOG"]["current_count"] == 2
        assert by_status["BACKLOG"]["breach"] is None  # no limit set
        assert by_status["IN_PROGRESS"]["current_count"] == 2
        assert by_status["IN_PROGRESS"]["breach"] == "at"
        assert by_status["REVIEW"]["current_count"] == 0
        assert by_status["REVIEW"]["breach"] == "ok"

    def test_over_limit_column_reads_over(self, project: Project) -> None:
        for i in range(3):
            Task.objects.create(
                project=project, name=f"P{i}", duration=1, status=TaskStatus.IN_PROGRESS
            )
        annotated = annotate_wip_breach(project.pk, [{"status": "IN_PROGRESS", "wip_limit": 2}])
        assert annotated[0]["breach"] == "over"

    def test_soft_deleted_tasks_do_not_count_toward_the_limit(self, project: Project) -> None:
        task = Task.objects.create(
            project=project, name="Gone", duration=1, status=TaskStatus.IN_PROGRESS
        )
        task.soft_delete()
        annotated = annotate_wip_breach(project.pk, [{"status": "IN_PROGRESS", "wip_limit": 1}])
        assert annotated[0]["current_count"] == 0

    def test_input_columns_are_not_mutated(self, project: Project) -> None:
        columns = [{"status": "REVIEW", "wip_limit": 1}]
        annotate_wip_breach(project.pk, columns)
        assert columns == [{"status": "REVIEW", "wip_limit": 1}]

    def test_unknown_column_status_counts_zero(self, project: Project) -> None:
        annotated = annotate_wip_breach(project.pk, [{"status": "NOT_A_COLUMN", "wip_limit": 3}])
        assert annotated[0]["current_count"] == 0
        assert annotated[0]["breach"] == "ok"


@pytest.mark.django_db
class TestTypicalSprintLengthDays:
    def test_falls_back_to_a_fortnight_without_sprints(self, project: Project) -> None:
        assert _typical_sprint_length_days(project.pk) == 14

    def test_derives_the_span_from_the_most_recent_sprint(self, project: Project) -> None:
        Sprint.objects.create(
            project=project, name="S1", start_date=MONDAY, finish_date=MONDAY + timedelta(days=6)
        )
        Sprint.objects.create(
            project=project,
            name="S2",
            start_date=MONDAY + timedelta(days=7),
            finish_date=MONDAY + timedelta(days=27),
        )
        assert _typical_sprint_length_days(project.pk) == 20

    def test_zero_length_sprint_falls_back_to_the_default(self, project: Project) -> None:
        """A one-day sprint yields a zero-day span, which is not a usable pace."""
        Sprint.objects.create(
            project=project, name="S1", start_date=MONDAY, finish_date=MONDAY + timedelta(days=1)
        )
        assert _typical_sprint_length_days(project.pk) == 1


@pytest.mark.django_db
class TestSchedulerVelocityInputs:
    def test_no_closed_sprints_yields_no_usable_signal(self, project: Project) -> None:
        assert scheduler_velocity_inputs(project.pk, 31) == ([], None)

    def test_closed_sprints_supply_samples_and_a_working_day_length(self, project: Project) -> None:
        for i, points in enumerate((8, 13)):
            Sprint.objects.create(
                project=project,
                name=f"S{i}",
                start_date=MONDAY + timedelta(days=14 * i),
                finish_date=MONDAY + timedelta(days=14 * i + 13),
                state=SprintState.COMPLETED,
                closed_at=timezone.now() + timedelta(minutes=i),
                completed_points=points,
            )
        samples, sprint_length = scheduler_velocity_inputs(project.pk, 31)
        # Newest-first ordering by closed_at.
        assert samples == [13.0, 8.0]
        # 13 calendar days × 5/7 working days per week, rounded.
        assert sprint_length == 9

    def test_velocity_excluded_sprint_is_not_a_sample(self, project: Project) -> None:
        Sprint.objects.create(
            project=project,
            name="S0",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=13),
            state=SprintState.COMPLETED,
            closed_at=timezone.now(),
            completed_points=8,
            exclude_from_velocity=True,
        )
        assert scheduler_velocity_inputs(project.pk, 31) == ([], None)

    def test_degenerate_all_zero_calendar_mask_falls_back_to_five_days(
        self, project: Project
    ) -> None:
        Sprint.objects.create(
            project=project,
            name="S0",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=13),
            state=SprintState.COMPLETED,
            closed_at=timezone.now(),
            completed_points=8,
        )
        _samples, sprint_length = scheduler_velocity_inputs(project.pk, 0)
        assert sprint_length == 9


@pytest.mark.django_db
class TestPrefersThroughputForecast:
    def test_no_velocity_signal_routes_to_flow(self, project: Project) -> None:
        assert _prefers_throughput_forecast(project.pk, velocity_sample_count=1) is True

    def test_board_with_no_declared_delivery_mode_stays_on_velocity(self, project: Project) -> None:
        assert _prefers_throughput_forecast(project.pk, velocity_sample_count=4) is False

    def test_kanban_majority_routes_to_flow_despite_closed_sprints(self, project: Project) -> None:
        for i in range(3):
            Task.objects.create(
                project=project, name=f"K{i}", duration=1, delivery_mode=DeliveryMode.KANBAN
            )
        Task.objects.create(
            project=project, name="S1", duration=1, delivery_mode=DeliveryMode.SCRUM
        )
        assert _prefers_throughput_forecast(project.pk, velocity_sample_count=4) is True

    def test_exact_kanban_tie_stays_on_velocity(self, project: Project) -> None:
        """A strict majority is required — half kanban is not a flow board."""
        Task.objects.create(
            project=project, name="K", duration=1, delivery_mode=DeliveryMode.KANBAN
        )
        Task.objects.create(project=project, name="S", duration=1, delivery_mode=DeliveryMode.SCRUM)
        assert _prefers_throughput_forecast(project.pk, velocity_sample_count=4) is False


# ---------------------------------------------------------------------------
# Structured service exceptions — the payloads the viewsets map to 400/403/409
# ---------------------------------------------------------------------------


class TestServiceExceptions:
    def test_demo_reorder_conflict_carries_the_drifted_ids(self) -> None:
        exc = DemoReorderConflict(["a", "b"])
        assert exc.ids == ["a", "b"]
        assert "reload and retry" in str(exc).lower()

    def test_queue_reorder_validation_names_the_offending_ids(self) -> None:
        exc = QueueReorderValidation(["t1", "t2"])
        assert exc.ids == ["t1", "t2"]
        assert "t1, t2" in str(exc)

    def test_queue_reorder_conflict_names_the_stale_ids(self) -> None:
        exc = QueueReorderConflict(["t9"])
        assert exc.ids == ["t9"]
        assert "Stale queue snapshot" in str(exc)

    def test_sprint_already_bound_carries_the_current_milestone(self) -> None:
        milestone_id = uuid.uuid4()
        exc = SprintAlreadyBound(milestone_id)
        assert exc.current_milestone_id == milestone_id
        assert str(exc) == "sprint_already_bound"
        assert isinstance(exc, MilestoneBindingError)

    def test_milestone_not_found_is_a_binding_error(self) -> None:
        assert issubclass(MilestoneNotFound, MilestoneBindingError)

    def test_scope_accept_forbidden_exposes_a_stable_error_code(self) -> None:
        """The viewset maps ``code`` without scraping the message (ADR-0102 §3)."""
        assert ScopeAcceptForbidden.code == "scope_accept_forbidden"
        assert "team-owned" in ScopeAcceptForbidden.detail


# ---------------------------------------------------------------------------
# Milestone rollup assembly (ADR-0074 / ADR-0106) — pure, pre-fetched aggregates
# ---------------------------------------------------------------------------


def _rollup_sprint(
    state: str,
    *,
    finish: date | None = None,
    committed_points: int | None = None,
    committed_task_count: int | None = None,
    completed_points: int | None = None,
    completed_task_count: int | None = None,
    binding_snapshot: int | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        pk=uuid.uuid4(),
        state=state,
        finish_date=finish,
        committed_points=committed_points,
        committed_task_count=committed_task_count,
        completed_points=completed_points,
        completed_task_count=completed_task_count,
        binding_committed_snapshot=binding_snapshot,
    )


class TestAssembleMilestoneRollup:
    def test_no_targeting_sprints_yields_no_rollup(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        assert _assemble_milestone_rollup(milestone, [], {}, {}) is None

    def test_completed_sprint_uses_its_immutable_snapshot(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        sprint = _rollup_sprint(
            SprintState.COMPLETED,
            committed_points=20,
            committed_task_count=4,
            completed_points=15,
            completed_task_count=3,
        )
        payload = _assemble_milestone_rollup(milestone, [sprint], {}, {})
        assert payload is not None
        assert payload["rollup_basis"] == "points"
        assert payload["percent_complete"] == 75.0
        assert payload["sprint_count"] == 1

    def test_active_sprint_uses_live_completion_and_flags_scope_change(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=date(2026, 3, 1))
        sprint = _rollup_sprint(
            SprintState.ACTIVE,
            finish=date(2026, 3, 10),
            committed_points=10,
            committed_task_count=2,
        )
        payload = _assemble_milestone_rollup(
            milestone, [sprint], {sprint.pk: 14}, {sprint.pk: (5, 1)}
        )
        assert payload is not None
        assert payload["percent_complete"] == 50.0
        assert payload["sprint_scope_changed"] is True
        assert payload["scope_change_sprint_id"] == str(sprint.pk)
        # Latest ACTIVE/PLANNED finish (Mar 10) vs the milestone CPM date (Mar 1).
        assert payload["variance_days"] == 9

    def test_active_sprint_matching_its_snapshot_is_not_a_scope_change(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        sprint = _rollup_sprint(SprintState.ACTIVE, finish=date(2026, 3, 10), committed_points=10)
        payload = _assemble_milestone_rollup(
            milestone, [sprint], {sprint.pk: 10}, {sprint.pk: (0, 0)}
        )
        assert payload is not None
        assert payload["sprint_scope_changed"] is False
        assert payload["scope_change_sprint_id"] is None
        # No milestone CPM date → variance is unknowable, never a misleading 0.
        assert payload["variance_days"] is None

    def test_planned_sprint_contributes_only_to_the_denominator(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=date(2026, 3, 20))
        sprint = _rollup_sprint(SprintState.PLANNED, finish=date(2026, 3, 10), committed_points=8)
        payload = _assemble_milestone_rollup(milestone, [sprint], {}, {})
        assert payload is not None
        assert payload["percent_complete"] == 0.0
        assert payload["variance_days"] == -10  # ahead of the milestone date

    def test_cancelled_sprint_contributes_nothing_but_still_counts(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        cancelled = _rollup_sprint(
            SprintState.CANCELLED, committed_points=100, completed_points=100
        )
        payload = _assemble_milestone_rollup(milestone, [cancelled], {}, {})
        assert payload is not None
        assert payload["rollup_basis"] == "none"
        assert payload["percent_complete"] is None
        # The milestone UI still surfaces the total link count.
        assert payload["sprint_count"] == 1

    def test_task_count_basis_is_the_fallback_when_no_points_are_committed(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        sprint = _rollup_sprint(
            SprintState.COMPLETED, committed_task_count=4, completed_task_count=1
        )
        payload = _assemble_milestone_rollup(milestone, [sprint], {}, {})
        assert payload is not None
        assert payload["rollup_basis"] == "tasks"
        assert payload["percent_complete"] == 25.0

    def test_completion_is_capped_at_one_hundred_percent(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        sprint = _rollup_sprint(SprintState.COMPLETED, committed_points=10, completed_points=25)
        payload = _assemble_milestone_rollup(milestone, [sprint], {}, {})
        assert payload is not None
        assert payload["percent_complete"] == 100.0

    def test_binding_drift_is_flagged_against_the_promote_time_snapshot(self) -> None:
        milestone = SimpleNamespace(pk=uuid.uuid4(), early_finish=None)
        sprint = _rollup_sprint(SprintState.PLANNED, finish=date(2026, 3, 1), binding_snapshot=13)
        drifted = _assemble_milestone_rollup(milestone, [sprint], {sprint.pk: 21}, {})
        steady = _assemble_milestone_rollup(milestone, [sprint], {sprint.pk: 13}, {})
        assert drifted is not None and steady is not None
        assert drifted["binding_drifted"] is True
        assert steady["binding_drifted"] is False


class TestSprintRollupAggregates:
    def test_only_cancelled_sprints_short_circuit_to_empty_maps(self) -> None:
        """No live sprint means no Task aggregate query at all."""
        cancelled = _rollup_sprint(SprintState.CANCELLED)
        assert _sprint_rollup_aggregates([cancelled]) == ({}, {})

    def test_empty_sprint_list_short_circuits(self) -> None:
        assert _sprint_rollup_aggregates([]) == ({}, {})


class TestBatchComputeMilestoneRollups:
    def test_empty_milestone_page_short_circuits(self) -> None:
        assert batch_compute_milestone_rollups([]) == {}


# ---------------------------------------------------------------------------
# Early-return guards on the standup / notification paths
# ---------------------------------------------------------------------------


def _spy_on_batch_notifications(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Record every ``create_event_notifications_batch`` call instead of writing rows."""
    from trueppm_api.apps.notifications import services as notification_services

    calls: list[dict[str, Any]] = []

    def _record(**kwargs: Any) -> list[Any]:
        calls.append(kwargs)
        return []

    monkeypatch.setattr(notification_services, "create_event_notifications_batch", _record)
    return calls


class TestNotificationGuards:
    def test_history_delta_replay_with_no_tasks_returns_empty_lists(self) -> None:
        assert _collect_history_deltas([], timezone.now(), timezone.now(), lambda *_: None) == (
            [],
            [],
        )

    def test_carryover_notification_with_no_moved_tasks_sends_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``carry_over_to="none"`` reaches here with an empty list — nothing to send."""
        sprint = SimpleNamespace(pk=uuid.uuid4(), name="S1", project_id=uuid.uuid4())
        calls = _spy_on_batch_notifications(monkeypatch)
        notify_carryover_assignees(sprint, "backlog", [])
        assert calls == []

    def test_membership_notification_ignores_a_no_op_patch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """old == new means the sprint link did not move, so nobody is notified."""
        sprint_id = uuid.uuid4()
        task = SimpleNamespace(pk=uuid.uuid4(), project_id=uuid.uuid4(), name="T")
        calls = _spy_on_batch_notifications(monkeypatch)
        notify_sprint_membership_change(task, sprint_id, str(sprint_id), None)
        assert calls == []


# ---------------------------------------------------------------------------
# Database-backed reads
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPendingScopeAdvisory:
    @pytest.fixture
    def sprint(self, project: Project) -> Sprint:
        return Sprint.objects.create(
            project=project,
            name="S1",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=6),
            state=SprintState.ACTIVE,
        )

    def test_no_pending_rows_yields_no_advisory(self, sprint: Sprint) -> None:
        assert pending_scope_advisory(sprint) is None

    def test_pending_rows_produce_a_non_blocking_carry_advisory(
        self, project: Project, sprint: Sprint
    ) -> None:
        task = Task.objects.create(
            project=project, name="Hotfix", duration=1, sprint=sprint, sprint_pending=True
        )
        SprintScopeChange.objects.create(task=task, sprint=sprint, subtask_name="Hotfix")
        advisory = pending_scope_advisory(sprint)
        assert advisory is not None
        assert advisory["code"] == "scope_pending_on_close"
        assert advisory["pending_count"] == 1
        assert advisory["default_disposition"] == "carry"
        assert advisory["items"][0]["item_name"] == "Hotfix"

    def test_accepted_rows_are_not_pending(self, project: Project, sprint: Sprint) -> None:
        task = Task.objects.create(project=project, name="Accepted", duration=1, sprint=sprint)
        SprintScopeChange.objects.create(
            task=task, sprint=sprint, subtask_name="Accepted", status=ScopeChangeStatus.ACCEPTED
        )
        assert pending_scope_advisory(sprint) is None

    def test_pending_count_tracks_the_flagged_tasks(self, project: Project, sprint: Sprint) -> None:
        Task.objects.create(
            project=project, name="Pending", duration=1, sprint=sprint, sprint_pending=True
        )
        Task.objects.create(project=project, name="Accepted", duration=1, sprint=sprint)
        deleted = Task.objects.create(
            project=project, name="Gone", duration=1, sprint=sprint, sprint_pending=True
        )
        deleted.soft_delete()
        assert sprint_pending_count(sprint.pk) == 1


@pytest.mark.django_db
class TestSprintChangeLogPayloads:
    @pytest.fixture
    def sprint(self, project: Project) -> Sprint:
        return Sprint.objects.create(
            project=project,
            name="S1",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=6),
            state=SprintState.ACTIVE,
        )

    def test_scope_change_payload_splits_added_and_removed_points(
        self, project: Project, sprint: Sprint
    ) -> None:
        added = Task.objects.create(
            project=project, name="Added", duration=1, sprint=sprint, story_points=5
        )
        rejected_task = Task.objects.create(
            project=project, name="Rejected", duration=1, story_points=3
        )
        SprintScopeChange.objects.create(task=added, sprint=sprint, subtask_name="Added")
        SprintScopeChange.objects.create(
            task=rejected_task,
            sprint=sprint,
            subtask_name="Rejected",
            status=ScopeChangeStatus.REJECTED,
        )
        payload = sprint_scope_change_payload(sprint)
        assert payload["summary"] == {
            "points_added": 5,
            "points_removed": 3,
            "added_mid_sprint_count": 1,
            "total": 2,
        }
        assert {e["item_name"] for e in payload["events"]} == {"Added", "Rejected"}

    def test_scope_change_payload_is_empty_for_an_untouched_sprint(self, sprint: Sprint) -> None:
        assert sprint_scope_change_payload(sprint) == {
            "summary": {
                "points_added": 0,
                "points_removed": 0,
                "added_mid_sprint_count": 0,
                "total": 0,
            },
            "events": [],
        }

    def test_duration_change_payload_lists_the_captured_events(
        self, project: Project, sprint: Sprint
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=3, sprint=sprint)
        TaskDurationChangeEvent.objects.create(
            task=task,
            sprint=sprint,
            old_duration=3,
            new_duration=5,
            percent_complete_at_change=50.0,
            percent_complete_after=30.0,
            policy_applied="prorate",
        )
        payload = sprint_duration_change_payload(sprint)
        assert len(payload["events"]) == 1
        event = payload["events"][0]
        assert event["old_duration"] == 3
        assert event["new_duration"] == 5
        assert event["percent_complete_after"] == 30.0
        assert event["task_name"] == "T"

    def test_duration_change_payload_is_empty_without_events(self, sprint: Sprint) -> None:
        assert sprint_duration_change_payload(sprint) == {"events": []}


@pytest.mark.django_db
class TestIncomingCarryover:
    def test_no_prior_closed_sprint_suppresses_the_panel(self, project: Project) -> None:
        planned = Sprint.objects.create(
            project=project,
            name="S2",
            start_date=MONDAY + timedelta(days=14),
            finish_date=MONDAY + timedelta(days=20),
        )
        assert incoming_carryover(planned) == {"prior_sprint": None, "tasks": []}

    def test_prior_sprint_unfinished_tasks_are_listed_with_a_pulled_in_flag(
        self, project: Project
    ) -> None:
        prior = Sprint.objects.create(
            project=project,
            name="S1",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=6),
            state=SprintState.COMPLETED,
        )
        planned = Sprint.objects.create(
            project=project,
            name="S2",
            start_date=MONDAY + timedelta(days=7),
            finish_date=MONDAY + timedelta(days=13),
        )
        pulled = Task.objects.create(
            project=project, name="Carried", duration=1, sprint=planned, story_points=3
        )
        left = Task.objects.create(project=project, name="Dropped", duration=1)
        # #2671: a snapshotted outcome's `task_short_id` is the same 8-hex-digit
        # value Task.short_id itself stores — a pretty fixture like "T-01" is
        # not a shape that can occur in production and hid the naive
        # f"SP-{...}"-style bug this row's own display form once had. Use real
        # hex here so a regression to that bug fails this test.
        SprintTaskOutcome.objects.create(
            sprint=prior,
            task=pulled,
            task_short_id="00000001",
            task_title="Carried",
            story_points=3,
            final_status=TaskStatus.IN_PROGRESS,
            disposition=SprintTaskDisposition.CARRIED,
        )
        SprintTaskOutcome.objects.create(
            sprint=prior,
            task=left,
            task_short_id="0000000A",
            task_title="Dropped",
            final_status=TaskStatus.NOT_STARTED,
            disposition=SprintTaskDisposition.DROPPED,
        )
        # A completed outcome is never "unfinished", so it must not appear.
        done = Task.objects.create(project=project, name="Shipped", duration=1)
        SprintTaskOutcome.objects.create(
            sprint=prior,
            task=done,
            task_short_id="00000003",
            task_title="Shipped",
            final_status=TaskStatus.COMPLETE,
            disposition=SprintTaskDisposition.COMPLETED,
        )
        result = incoming_carryover(planned)
        assert result["prior_sprint"] is not None
        assert result["prior_sprint"]["name"] == "S1"
        # `prior` is the project's first sprint, so its raw short_id is
        # "00000001" — the display form must decode it, not echo the hex.
        assert result["prior_sprint"]["short_id_display"] == "SP-1"
        by_title = {row["name"]: row for row in result["tasks"]}
        assert set(by_title) == {"Carried", "Dropped"}
        assert by_title["Carried"]["pulled_in_to_current"] is True
        assert by_title["Dropped"]["pulled_in_to_current"] is False
        # #2671: the carryover row's task reference must also decode — this is
        # the raw `SprintTaskOutcome.task_short_id` snapshot, not Task's own
        # server-owned `short_id_display` field, so it needs its own assertion.
        assert by_title["Carried"]["short_id_display"] == "T-1"
        assert by_title["Dropped"]["short_id_display"] == "T-10"


@pytest.mark.django_db
class TestListProjectMilestones:
    def test_milestones_are_annotated_with_their_binding_state(self, project: Project) -> None:
        bound = Task.objects.create(
            project=project,
            name="Bound",
            duration=0,
            is_milestone=True,
            early_finish=MONDAY,
        )
        Task.objects.create(
            project=project,
            name="Unbound",
            duration=0,
            is_milestone=True,
            early_finish=MONDAY + timedelta(days=5),
        )
        Task.objects.create(project=project, name="Ordinary", duration=1)
        Sprint.objects.create(
            project=project,
            name="S1",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=6),
            target_milestone=bound,
        )
        rows = list(list_project_milestones(project.pk))
        assert [row.name for row in rows] == ["Bound", "Unbound"]
        assert [row.is_bound for row in rows] == [True, False]

    def test_unbound_only_filters_out_the_bound_milestone(self, project: Project) -> None:
        bound = Task.objects.create(project=project, name="Bound", duration=0, is_milestone=True)
        Task.objects.create(project=project, name="Unbound", duration=0, is_milestone=True)
        Sprint.objects.create(
            project=project,
            name="S1",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(days=6),
            target_milestone=bound,
        )
        rows = list(list_project_milestones(project.pk, unbound_only=True))
        assert [row.name for row in rows] == ["Unbound"]


@pytest.mark.django_db
class TestComputeScopeRollup:
    def test_leaf_task_rolls_up_its_own_points_with_no_baseline(self, project: Project) -> None:
        leaf = Task.objects.create(
            project=project, name="Leaf", duration=1, wbs_path="1", story_points=5
        )
        assert compute_scope_rollup(leaf) == {
            "current_scope": 5,
            "baselined_scope": None,
            "scope_delta": None,
            "has_baseline": False,
        }

    def test_parent_rolls_up_its_leaf_descendants_only(self, project: Project) -> None:
        parent = Task.objects.create(
            project=project, name="Phase", duration=1, wbs_path="1", story_points=99
        )
        Task.objects.create(project=project, name="A", duration=1, wbs_path="1.1", story_points=3)
        Task.objects.create(project=project, name="B", duration=1, wbs_path="1.2", story_points=4)
        rollup = compute_scope_rollup(parent)
        # The parent's own 99 is a summary value, never part of the leaf sum.
        assert rollup["current_scope"] == 7

    def test_a_parent_whose_leaves_carry_no_points_rolls_up_zero(self, project: Project) -> None:
        """Zero is a real reading, not "unknown" — the sum of nothing is 0, never null."""
        parent = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="A", duration=1, wbs_path="1.1")
        Task.objects.create(project=project, name="B", duration=1, wbs_path="1.2")
        assert compute_scope_rollup(parent)["current_scope"] == 0

    def test_task_without_a_wbs_path_rolls_up_only_itself(self, project: Project) -> None:
        recurring = Task.objects.create(project=project, name="Daily", duration=1, story_points=2)
        assert compute_scope_rollup(recurring)["current_scope"] == 2

    def test_active_baseline_supplies_the_delta(self, project: Project) -> None:
        leaf = Task.objects.create(
            project=project, name="Leaf", duration=1, wbs_path="1", story_points=8
        )
        baseline = Baseline.objects.create(project=project, name="B1", is_active=True)
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=leaf.pk,
            task_name="Leaf",
            duration=1,
            story_points=5,
        )
        rollup = compute_scope_rollup(leaf)
        assert rollup["has_baseline"] is True
        assert rollup["baselined_scope"] == 5
        assert rollup["scope_delta"] == 3

    def test_the_baselined_sum_is_scoped_to_the_subtrees_leaves(self, project: Project) -> None:
        """Multi-row ``Sum``, restricted to the subtree — what the n=1 cases cannot see.

        Every other baseline case in this class has exactly one ``BaselineTask`` row
        and one leaf, so dropping ``task_id__in=leaf_ids`` (or reading a single row
        instead of summing) leaves all of them green. This case is arranged so both
        defects change the answer: the subtree's two leaves baseline to 5 + 8 = 13
        while a leaf *outside* the subtree carries 100, so an unrestricted sum reads
        113 and a single-row read reads 5. The same out-of-subtree row makes
        ``current_scope``'s own ltree filter non-vacuous (28, never 128).

        This is the arithmetic the ``GET /api/v1/tasks/{id}/scope/`` test asserted
        before #3370 removed that route; the route is gone, the rollup is not.
        """
        parent = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        leaf_a = Task.objects.create(
            project=project, name="A", duration=1, wbs_path="1.1", story_points=20
        )
        leaf_b = Task.objects.create(
            project=project, name="B", duration=1, wbs_path="1.2", story_points=8
        )
        outside = Task.objects.create(
            project=project, name="Elsewhere", duration=1, wbs_path="2", story_points=100
        )
        baseline = Baseline.objects.create(project=project, name="B1", is_active=True)
        for task, points in ((leaf_a, 5), (leaf_b, 8), (outside, 100)):
            BaselineTask.objects.create(
                baseline=baseline,
                task_id=task.pk,
                task_name=task.name,
                duration=1,
                story_points=points,
            )

        rollup = compute_scope_rollup(parent)
        assert rollup["current_scope"] == 28
        assert rollup["baselined_scope"] == 13
        assert rollup["scope_delta"] == 15
        assert rollup["has_baseline"] is True

    def test_baseline_without_captured_points_reports_no_delta(self, project: Project) -> None:
        """A pre-story_points baseline must read "no baseline", never a phantom 0."""
        leaf = Task.objects.create(
            project=project, name="Leaf", duration=1, wbs_path="1", story_points=8
        )
        baseline = Baseline.objects.create(project=project, name="B1", is_active=True)
        BaselineTask.objects.create(
            baseline=baseline, task_id=leaf.pk, task_name="Leaf", duration=1
        )
        rollup = compute_scope_rollup(leaf)
        assert rollup["has_baseline"] is True
        assert rollup["baselined_scope"] is None
        assert rollup["scope_delta"] is None


@pytest.mark.django_db
class TestExportEnqueueDeduplication:
    def test_project_export_creates_one_job(self, project: Project, django_user_model: Any) -> None:
        user = django_user_model.objects.create_user(username="admin", password="pw")
        job = enqueue_project_export(project=project, requested_by=user)
        assert job.status == ExportJobStatus.PENDING
        assert job.requested_by_id == user.pk

    def test_project_export_returns_the_in_flight_job_instead_of_queueing_again(
        self, project: Project, django_user_model: Any
    ) -> None:
        user = django_user_model.objects.create_user(username="admin", password="pw")
        first = enqueue_project_export(project=project, requested_by=user)
        second = enqueue_project_export(project=project, requested_by=user)
        assert second.pk == first.pk
        assert ProjectExportJob.objects.filter(project=project).count() == 1

    def test_project_export_queues_again_once_the_prior_job_finished(
        self, project: Project, django_user_model: Any
    ) -> None:
        user = django_user_model.objects.create_user(username="admin", password="pw")
        first = enqueue_project_export(project=project, requested_by=user)
        ProjectExportJob.objects.filter(pk=first.pk).update(status=ExportJobStatus.SUCCESS)
        second = enqueue_project_export(project=project, requested_by=user)
        assert second.pk != first.pk

    def test_program_export_dedupes_in_flight_work(
        self, db: object, django_user_model: Any
    ) -> None:
        user = django_user_model.objects.create_user(username="admin", password="pw")
        program = Program.objects.create(name="Apollo")
        first = enqueue_program_export(program=program, requested_by=user)
        second = enqueue_program_export(program=program, requested_by=user)
        assert second.pk == first.pk
        assert ProgramExportJob.objects.filter(program=program).count() == 1


@pytest.mark.django_db
class TestCapacitySummariesForSprintsBatch:
    def test_batched_summaries_match_the_per_sprint_totals(self, project: Project) -> None:
        """The batched path must be byte-identical to capacity_summary (#1012)."""
        from trueppm_api.apps.resources.models import Resource, TaskResource

        sprint_a = Sprint.objects.create(
            project=project, name="A", start_date=MONDAY, finish_date=MONDAY + timedelta(days=4)
        )
        sprint_b = Sprint.objects.create(
            project=project,
            name="B",
            start_date=MONDAY + timedelta(days=7),
            finish_date=MONDAY + timedelta(days=11),
        )
        resource = Resource.objects.create(name="Priya Raman", max_units=Decimal("1.0"))
        task = Task.objects.create(
            project=project,
            name="T",
            duration=5,
            sprint=sprint_a,
            early_start=MONDAY,
            early_finish=MONDAY + timedelta(days=4),
        )
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))

        summaries = capacity_summaries_for_sprints([sprint_a, sprint_b])
        assert set(summaries) == {sprint_a.pk, sprint_b.pk}
        assert summaries[sprint_a.pk] == capacity_summary(sprint_a)
        assert summaries[sprint_a.pk]["totals"]["committed_hours"] == 40.0
        # A sprint with no assignments keeps the same empty-totals shape.
        assert summaries[sprint_b.pk]["members"] == []
        assert summaries[sprint_b.pk]["totals"]["committed_hours"] == 0.0
