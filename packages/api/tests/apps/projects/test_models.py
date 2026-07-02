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
class TestTaskSoftDelete:
    """Task.soft_delete() — tombstone, server_version bump, CommittedTaskManager exclusion."""

    def setup_method(self) -> None:
        self.project = Project.objects.create(name="SoftDelProj", start_date=date(2026, 3, 2))

    def test_tombstone_set(self) -> None:
        t = Task.objects.create(project=self.project, name="T", duration=1)
        t.soft_delete()
        t.refresh_from_db()
        assert t.is_deleted is True

    def test_server_version_bumped(self) -> None:
        t = Task.objects.create(project=self.project, name="T", duration=1)
        version_before = t.server_version
        t.soft_delete()
        t.refresh_from_db()
        assert t.server_version > version_before

    def test_excluded_from_committed_queryset(self) -> None:
        t = Task.objects.create(project=self.project, name="T", duration=1)
        assert Task.committed.filter(pk=t.pk).exists()
        t.soft_delete()
        assert not Task.committed.filter(pk=t.pk).exists()

    def test_dependency_edges_soft_deleted(self) -> None:
        t1 = Task.objects.create(project=self.project, name="A", duration=1)
        t2 = Task.objects.create(project=self.project, name="B", duration=1)
        dep = Dependency.objects.create(predecessor=t1, successor=t2)
        t1.soft_delete()
        dep.refresh_from_db()
        assert dep.is_deleted is True

    def test_deleted_at_stamped(self) -> None:
        """soft_delete() stamps deleted_at — the tombstone-reap age_field (sync/tasks.py)."""
        t = Task.objects.create(project=self.project, name="T", duration=1)
        assert t.deleted_at is None
        t.soft_delete()
        t.refresh_from_db()
        assert t.deleted_at is not None

    def test_cascaded_dependency_stamps_its_own_deleted_at(self) -> None:
        """A cascade-soft-deleted Dependency edge stamps its own deleted_at.

        Each cascaded row calls its own soft_delete() rather than inheriting the
        parent's timestamp — the dependency's retention grace period should be
        measured from when the edge itself was tombstoned.
        """
        t1 = Task.objects.create(project=self.project, name="A", duration=1)
        t2 = Task.objects.create(project=self.project, name="B", duration=1)
        dep = Dependency.objects.create(predecessor=t1, successor=t2)
        assert dep.deleted_at is None
        t1.soft_delete()
        dep.refresh_from_db()
        assert dep.deleted_at is not None


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


@pytest.mark.django_db
class TestDependencySoftDelete:
    """Dependency.soft_delete() — tombstone, server_version bump, deleted_at stamp."""

    def setup_method(self) -> None:
        self.project = Project.objects.create(name="DepSoftDelProj", start_date=date(2026, 3, 2))
        self.t1 = Task.objects.create(project=self.project, name="A", duration=1)
        self.t2 = Task.objects.create(project=self.project, name="B", duration=1)

    def test_tombstone_set(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        dep.soft_delete()
        dep.refresh_from_db()
        assert dep.is_deleted is True

    def test_server_version_bumped(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        version_before = dep.server_version
        dep.soft_delete()
        dep.refresh_from_db()
        assert dep.server_version > version_before

    def test_deleted_at_stamped(self) -> None:
        """soft_delete() stamps deleted_at — the tombstone-reap age_field (sync/tasks.py)."""
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        assert dep.deleted_at is None
        dep.soft_delete()
        dep.refresh_from_db()
        assert dep.deleted_at is not None
