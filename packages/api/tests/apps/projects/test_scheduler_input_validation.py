"""Defense-in-depth validators that keep adversarial schedule input out of the DB.

Mirrors the engine-level guards added in trueppm-scheduler (issue #749): a
calendar with no working day, an out-of-range duration/lag, etc. would drive the
CPM calendar walk into a multi-million-iteration spin. These validators reject
the input at the write boundary so it never reaches the (synchronous) Monte
Carlo request path or a Celery CPM run.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.core.exceptions import ValidationError

from trueppm_api.apps.projects.models import (
    MAX_DEPENDENCY_LAG_DAYS,
    MAX_TASK_DURATION_DAYS,
    Calendar,
    Dependency,
    Project,
    Task,
    validate_working_day_mask,
)


class TestBoundParity:
    def test_api_bounds_match_engine(self) -> None:
        """The API bounds must stay in lockstep with the engine's exported values.

        They are duplicated (not imported) so loading models doesn't pull
        numpy/networkx in via the engine; this test is the anti-drift guard.
        """
        from trueppm_scheduler.engine import MAX_DURATION_DAYS, MAX_LAG_DAYS

        assert MAX_TASK_DURATION_DAYS == MAX_DURATION_DAYS
        assert MAX_DEPENDENCY_LAG_DAYS == MAX_LAG_DAYS


class TestWorkingDayMaskValidator:
    def test_zero_mask_rejected(self) -> None:
        with pytest.raises(ValidationError):
            validate_working_day_mask(0)

    def test_only_non_weekday_bits_rejected(self) -> None:
        # Bit 7 (value 128) is ignored by the scheduler — no working day.
        with pytest.raises(ValidationError):
            validate_working_day_mask(0b1000_0000)

    @pytest.mark.parametrize("mask", [31, 64, 1, 0b111_1111])
    def test_valid_masks_pass(self, mask: int) -> None:
        validate_working_day_mask(mask)  # does not raise


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


class TestCalendarModelValidation:
    def test_full_clean_rejects_empty_mask(self, db: object) -> None:
        cal = Calendar(name="bad", working_days=0)
        with pytest.raises(ValidationError) as exc:
            cal.full_clean()
        assert "working_days" in exc.value.message_dict

    def test_full_clean_accepts_default_mask(self, db: object) -> None:
        Calendar(name="ok", working_days=31).full_clean()  # does not raise


class TestTaskDurationValidation:
    def test_duration_over_max_rejected(self, project: Project) -> None:
        t = Task(project=project, name="T", duration=MAX_TASK_DURATION_DAYS + 1)
        with pytest.raises(ValidationError) as exc:
            t.full_clean()
        assert "duration" in exc.value.message_dict

    def test_negative_duration_rejected(self, project: Project) -> None:
        t = Task(project=project, name="T", duration=-1)
        with pytest.raises(ValidationError) as exc:
            t.full_clean()
        assert "duration" in exc.value.message_dict

    def test_duration_at_max_accepted(self, project: Project) -> None:
        Task(project=project, name="T", duration=MAX_TASK_DURATION_DAYS).full_clean()

    def test_pert_estimate_over_max_rejected(self, project: Project) -> None:
        t = Task(
            project=project,
            name="T",
            duration=1,
            pessimistic_duration=MAX_TASK_DURATION_DAYS + 1,
        )
        with pytest.raises(ValidationError) as exc:
            t.full_clean()
        assert "pessimistic_duration" in exc.value.message_dict


class TestDependencyLagValidation:
    def test_lag_over_max_rejected(self, project: Project) -> None:
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=project, name="B", duration=1)
        dep = Dependency(predecessor=a, successor=b, lag=MAX_DEPENDENCY_LAG_DAYS + 1)
        with pytest.raises(ValidationError) as exc:
            dep.full_clean()
        assert "lag" in exc.value.message_dict

    def test_negative_lag_under_min_rejected(self, project: Project) -> None:
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=project, name="B", duration=1)
        dep = Dependency(predecessor=a, successor=b, lag=-(MAX_DEPENDENCY_LAG_DAYS + 1))
        with pytest.raises(ValidationError) as exc:
            dep.full_clean()
        assert "lag" in exc.value.message_dict
