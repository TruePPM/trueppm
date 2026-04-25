"""Tests for summary task rollup during CPM write-back (issue #162).

After recalculate_schedule runs, summary tasks must have:
  - early_start = min(leaf early_start)
  - early_finish = max(leaf early_finish)
  - duration = calendar-day span (early_finish - early_start)
  - is_critical = any(leaf is_critical)
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="rollup_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(user: object, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Rollup Project", start_date=date(2026, 1, 5), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


def _run_schedule(project_id: str) -> None:
    """Invoke the scheduling logic synchronously (bypasses Celery queue)."""
    from trueppm_api.apps.scheduling.tasks import _run_schedule as _do_run

    _do_run(str(project_id), tracker=None)


@pytest.mark.django_db
class TestSummaryRollup:
    def test_summary_early_start_is_min_of_children(self, project: Project) -> None:
        """Summary task early_start = earliest leaf early_start."""
        phase = Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="T1", duration=3, wbs_path="1.1")
        Task.objects.create(project=project, name="T2", duration=5, wbs_path="1.2")
        _run_schedule(str(project.pk))
        phase.refresh_from_db()
        # Both tasks start on the project start_date (Mon Jan 5 2026)
        assert phase.early_start == date(2026, 1, 5)

    def test_summary_early_finish_is_max_of_children(self, project: Project) -> None:
        """Summary task early_finish = latest leaf early_finish."""
        phase = Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="T1", duration=3, wbs_path="1.1")
        Task.objects.create(project=project, name="T2", duration=5, wbs_path="1.2")
        _run_schedule(str(project.pk))
        phase.refresh_from_db()
        # Both tasks start Jan 5. T1 ends Jan 7, T2 ends Jan 9 (5 working days).
        assert phase.early_finish is not None
        assert phase.early_finish >= date(2026, 1, 9)

    def test_summary_duration_equals_span(self, project: Project) -> None:
        """Summary task duration is updated to calendar-day span after CPM."""
        phase = Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="T1", duration=5, wbs_path="1.1")
        _run_schedule(str(project.pk))
        phase.refresh_from_db()
        # Duration must reflect the CPM span, not the stale stored value of 1.
        expected_span = max(1, (phase.early_finish - phase.early_start).days)
        assert phase.duration == expected_span

    def test_summary_is_critical_when_any_child_is_critical(self, project: Project) -> None:
        """Summary task is_critical = True if any leaf is on the critical path."""
        phase = Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="T1", duration=5, wbs_path="1.1")
        _run_schedule(str(project.pk))
        phase.refresh_from_db()
        # Single-task project: the sole leaf is always on the critical path.
        assert phase.is_critical is True

    def test_leaf_duration_unchanged(self, project: Project) -> None:
        """Leaf task duration must NOT be overwritten during CPM write-back."""
        Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")
        leaf = Task.objects.create(project=project, name="T1", duration=7, wbs_path="1.1")
        _run_schedule(str(project.pk))
        leaf.refresh_from_db()
        assert leaf.duration == 7
