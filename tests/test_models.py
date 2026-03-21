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
        cal = Calendar(
            exceptions=[DateRange(start=date(2026, 3, 2), end=date(2026, 3, 2))]
        )
        assert not cal.is_working_day(date(2026, 3, 2))

    def test_roundtrip(self) -> None:
        cal = Calendar(
            working_days=0b0011111,
            exceptions=[DateRange(start=date(2026, 12, 25), end=date(2026, 12, 26))],
            hours_per_day=7.5,
            timezone="America/New_York",
        )
        assert Calendar.from_dict(cal.to_dict()) == cal


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
                exceptions=[
                    DateRange(start=date(2026, 3, 10), end=date(2026, 3, 10))
                ]
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
