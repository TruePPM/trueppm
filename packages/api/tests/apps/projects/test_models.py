"""Model tests for the projects app — require a real PostgreSQL instance."""

from __future__ import annotations

from datetime import date

import pytest

from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Dependency,
    Project,
    Task,
)


@pytest.mark.django_db
class TestCalendar:
    def test_str(self) -> None:
        cal = Calendar(name="Standard")
        assert str(cal) == "Standard"

    def test_defaults(self) -> None:
        cal = Calendar(name="Test")
        assert cal.working_days == 31  # Mon–Fri
        assert cal.hours_per_day == 8.0
        assert cal.timezone == "UTC"

    def test_create_and_retrieve(self) -> None:
        cal = Calendar.objects.create(name="Custom", working_days=63, hours_per_day=9.0)
        retrieved = Calendar.objects.get(pk=cal.pk)
        assert retrieved.name == "Custom"
        assert retrieved.working_days == 63

    def test_server_version_increments_on_update(self) -> None:
        cal = Calendar.objects.create(name="V test")
        # INSERT now sets server_version=1 so sync since=0 returns all rows.
        assert cal.server_version == 1
        cal.name = "V test updated"
        cal.save()
        cal.refresh_from_db()
        assert cal.server_version == 2


@pytest.mark.django_db
class TestCalendarException:
    def test_create(self) -> None:
        cal = Calendar.objects.create(name="Cal")
        exc = CalendarException.objects.create(
            calendar=cal,
            exc_start=date(2026, 12, 25),
            exc_end=date(2026, 12, 26),
            description="Christmas",
        )
        assert exc.description == "Christmas"
        assert CalendarException.objects.filter(calendar=cal).count() == 1


@pytest.mark.django_db
class TestProject:
    def test_str(self) -> None:
        cal = Calendar.objects.create(name="Cal")
        p = Project(name="Alpha", start_date=date(2026, 3, 2), calendar=cal)
        assert str(p) == "Alpha"

    def test_create_without_calendar(self) -> None:
        p = Project.objects.create(name="No Cal", start_date=date(2026, 1, 1))
        assert p.calendar is None

    def test_ordering(self) -> None:
        Project.objects.create(name="B", start_date=date(2026, 2, 1))
        Project.objects.create(name="A", start_date=date(2026, 1, 1))
        names = list(Project.objects.values_list("name", flat=True))
        assert names == ["A", "B"]


@pytest.mark.django_db
class TestTask:
    def setup_method(self) -> None:
        self.project = Project.objects.create(name="P", start_date=date(2026, 3, 2))

    def test_str(self) -> None:
        t = Task(project=self.project, name="Design")
        assert "Design" in str(t)
        assert "P" in str(t)

    def test_defaults(self) -> None:
        t = Task.objects.create(project=self.project, name="T1")
        assert t.duration == 1
        assert t.percent_complete == 0.0
        assert t.is_critical is None
        assert t.early_start is None

    def test_wbs_path_stored_and_retrieved(self) -> None:
        t = Task.objects.create(project=self.project, name="T1", wbs_path="1.2.3")
        t.refresh_from_db()
        assert t.wbs_path == "1.2.3"

    def test_cpm_fields_writable(self) -> None:
        t = Task.objects.create(
            project=self.project,
            name="T2",
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 6),
            is_critical=True,
            total_float=0,
        )
        t.refresh_from_db()
        assert t.early_start == date(2026, 3, 2)
        assert t.is_critical is True

    def test_pert_fields(self) -> None:
        t = Task.objects.create(
            project=self.project,
            name="T3",
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=10,
        )
        t.refresh_from_db()
        assert t.optimistic_duration == 3
        assert t.pessimistic_duration == 10


@pytest.mark.django_db
class TestDependency:
    def setup_method(self) -> None:
        self.project = Project.objects.create(name="P", start_date=date(2026, 3, 2))
        self.t1 = Task.objects.create(project=self.project, name="A", duration=5)
        self.t2 = Task.objects.create(project=self.project, name="B", duration=3)

    def test_create_fs(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        assert dep.dep_type == "FS"
        assert dep.lag == 0

    def test_create_with_lag(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2, lag=2)
        assert dep.lag == 2

    def test_unique_constraint(self) -> None:
        from django.db import IntegrityError

        Dependency.objects.create(predecessor=self.t1, successor=self.t2, dep_type="FS")
        with pytest.raises(IntegrityError):
            Dependency.objects.create(predecessor=self.t1, successor=self.t2, dep_type="FS")

    def test_str(self) -> None:
        dep = Dependency(predecessor=self.t1, successor=self.t2, dep_type="FS", lag=0)
        assert "FS" in str(dep)
