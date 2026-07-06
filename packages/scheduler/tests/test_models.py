"""Tests for core data structures."""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    Project,
    Task,
)


class TestDateRange:
    def test_valid_range(self) -> None:
        dr = DateRange(start=date(2026, 1, 1), end=date(2026, 1, 5))
        assert dr.start == date(2026, 1, 1)

    def test_invalid_range_raises(self) -> None:
        with pytest.raises(ValueError, match=r"end .* must be >= start"):
            DateRange(start=date(2026, 1, 5), end=date(2026, 1, 1))

    def test_roundtrip(self) -> None:
        dr = DateRange(start=date(2026, 1, 1), end=date(2026, 1, 5))
        assert DateRange.from_dict(dr.to_dict()) == dr


class TestTask:
    def test_defaults(self) -> None:
        t = Task(id="1", name="A", duration=timedelta(days=5))
        assert t.planned_start is None
        assert t.is_critical is False
        assert t.percent_complete == 0.0
        assert t.total_float == timedelta()

    def test_roundtrip_dict(self) -> None:
        t = Task(
            id="1",
            name="Design",
            duration=timedelta(days=5),
            planned_start=date(2026, 3, 1),
            planned_finish=date(2026, 3, 5),
            optimistic_duration=timedelta(days=3),
            most_likely_duration=timedelta(days=5),
            pessimistic_duration=timedelta(days=10),
        )
        restored = Task.from_dict(t.to_dict())
        assert restored == t

    def test_roundtrip_json(self) -> None:
        t = Task(id="1", name="A", duration=timedelta(days=5))
        data = json.loads(json.dumps(t.to_dict()))
        assert Task.from_dict(data) == t


class TestDependency:
    def test_defaults(self) -> None:
        d = Dependency(predecessor_id="1", successor_id="2")
        assert d.dep_type == DependencyType.FS
        assert d.lag == timedelta()

    def test_roundtrip(self) -> None:
        d = Dependency(
            predecessor_id="1",
            successor_id="2",
            dep_type=DependencyType.SS,
            lag=timedelta(days=2),
        )
        assert Dependency.from_dict(d.to_dict()) == d


class TestCalendar:
    def test_default_working_days(self) -> None:
        cal = Calendar()
        # Monday 2026-03-02 is a working day
        assert cal.is_working_day(date(2026, 3, 2))
        # Saturday 2026-03-07
        assert not cal.is_working_day(date(2026, 3, 7))
        # Sunday 2026-03-08
        assert not cal.is_working_day(date(2026, 3, 8))

    def test_exception_overrides(self) -> None:
        cal = Calendar(exceptions=[DateRange(start=date(2026, 3, 2), end=date(2026, 3, 2))])
        assert not cal.is_working_day(date(2026, 3, 2))

    def test_roundtrip(self) -> None:
        cal = Calendar(
            working_days=0b0011111,
            exceptions=[DateRange(start=date(2026, 12, 25), end=date(2026, 12, 26))],
            hours_per_day=7.5,
            timezone="America/New_York",
        )
        assert Calendar.from_dict(cal.to_dict()) == cal


class TestCalendarCompose:
    """Overlay semantics for composable working calendars (#906)."""

    def test_empty_iterable_yields_default(self) -> None:
        cal = Calendar.compose([])
        assert cal.working_days == 0b0011111
        assert cal.exceptions == []
        assert cal.is_working_day(date(2026, 3, 2))  # Monday
        assert not cal.is_working_day(date(2026, 3, 7))  # Saturday

    def test_single_calendar_passes_through(self) -> None:
        base = Calendar(exceptions=[DateRange(start=date(2026, 12, 25), end=date(2026, 12, 25))])
        cal = Calendar.compose([base])
        assert cal.working_days == base.working_days
        assert not cal.is_working_day(date(2026, 12, 25))

    def test_exceptions_union_across_calendars(self) -> None:
        # Project (Mon-Fri) + a holidays calendar contributing Christmas + a
        # workspace shutdown calendar contributing New Year's Day.
        project = Calendar()
        holidays = Calendar(
            exceptions=[DateRange(start=date(2026, 12, 25), end=date(2026, 12, 25))]
        )
        shutdown = Calendar(exceptions=[DateRange(start=date(2027, 1, 1), end=date(2027, 1, 1))])
        cal = Calendar.compose([project, holidays, shutdown])
        # A day is non-working if ANY source marks it non-working.
        assert not cal.is_working_day(date(2026, 12, 25))  # from holidays
        assert not cal.is_working_day(date(2027, 1, 1))  # from shutdown
        assert cal.is_working_day(date(2026, 12, 24))  # working in all three

    def test_working_days_is_intersection(self) -> None:
        # Mon-Fri AND-ed with a Mon-Thu part-time mask yields Mon-Thu: a weekday
        # is working only when every source treats it as working.
        full = Calendar(working_days=0b0011111)  # Mon-Fri
        part_time = Calendar(working_days=0b0001111)  # Mon-Thu
        cal = Calendar.compose([full, part_time])
        assert cal.working_days == 0b0001111
        assert cal.is_working_day(date(2026, 3, 5))  # Thursday
        assert not cal.is_working_day(date(2026, 3, 6))  # Friday — dropped by part-time

    def test_overlapping_exceptions_collapse(self) -> None:
        a = Calendar(exceptions=[DateRange(start=date(2026, 12, 22), end=date(2026, 12, 28))])
        b = Calendar(exceptions=[DateRange(start=date(2026, 12, 25), end=date(2027, 1, 2))])
        cal = Calendar.compose([a, b])
        # The merged interval index treats the overlapping ranges as one span.
        assert not cal.is_working_day(date(2026, 12, 22))
        assert not cal.is_working_day(date(2027, 1, 1))
        assert cal.is_working_day(date(2027, 1, 5))  # Monday after, outside both

    def test_reserved_fields_from_first_source(self) -> None:
        first = Calendar(hours_per_day=6.0, timezone="America/New_York")
        second = Calendar(hours_per_day=8.0, timezone="UTC")
        cal = Calendar.compose([first, second])
        assert cal.hours_per_day == 6.0
        assert cal.timezone == "America/New_York"


class TestProject:
    @pytest.fixture()
    def sample_project(self) -> Project:
        return Project(
            id="proj-1",
            name="Test Project",
            start_date=date(2026, 3, 1),
            tasks=[
                Task(id="1", name="A", duration=timedelta(days=5)),
                Task(id="2", name="B", duration=timedelta(days=3)),
            ],
            dependencies=[
                Dependency(predecessor_id="1", successor_id="2"),
            ],
            calendar=Calendar(
                exceptions=[DateRange(start=date(2026, 3, 10), end=date(2026, 3, 10))]
            ),
        )

    def test_roundtrip_dict(self, sample_project: Project) -> None:
        assert Project.from_dict(sample_project.to_dict()) == sample_project

    def test_roundtrip_json(self, sample_project: Project) -> None:
        json_str = sample_project.to_json(indent=2)
        restored = Project.from_json(json_str)
        assert restored == sample_project

    def test_empty_project(self) -> None:
        p = Project(id="empty", name="Empty", start_date=date(2026, 1, 1))
        assert p.tasks == []
        assert p.dependencies == []
        assert Project.from_dict(p.to_dict()) == p


class TestDeserializationExceptionSurface:
    """from_dict / from_json wrap malformed input in InvalidScheduleInput (#826)."""

    def test_project_from_dict_missing_key_raises_invalid_input(self) -> None:
        from trueppm_scheduler import InvalidScheduleInput

        with pytest.raises(InvalidScheduleInput):
            Project.from_dict({"name": "no id"})

    def test_project_from_json_malformed_json_raises_invalid_input(self) -> None:
        from trueppm_scheduler import InvalidScheduleInput

        with pytest.raises(InvalidScheduleInput):
            Project.from_json("{not valid json")

    def test_date_range_from_dict_bad_date_raises_invalid_input(self) -> None:
        from trueppm_scheduler import InvalidScheduleInput

        with pytest.raises(InvalidScheduleInput):
            DateRange.from_dict({"start": "not-a-date", "end": "2026-01-02"})
