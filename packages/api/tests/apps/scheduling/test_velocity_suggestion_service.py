"""Service-level tests for compute_velocity_suggestions and rolling velocity (ADR-0065)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    EstimationMode,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling.models import VelocitySuggestion
from trueppm_api.apps.scheduling.services import (
    MIN_CLOSED_SPRINTS_FOR_SUGGESTION,
    compute_team_velocity_per_day,
    compute_velocity_suggestions,
)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=cal)


def _closed_sprint(
    project: Project,
    *,
    name: str,
    start: date,
    finish: date,
    completed_points: int | None,
    closed_at: object | None = None,
) -> Sprint:
    """Create a COMPLETED sprint with explicit completed_points."""
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=start,
        finish_date=finish,
        state=SprintState.COMPLETED,
        completed_points=completed_points,
        closed_at=closed_at or timezone.now(),
    )


# ---------------------------------------------------------------------------
# compute_team_velocity_per_day
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_velocity_none_when_no_history(project: Project) -> None:
    assert compute_team_velocity_per_day(project.pk) is None


@pytest.mark.django_db
def test_velocity_none_below_threshold(project: Project) -> None:
    # Two closed sprints — below the 3-sprint minimum.
    _closed_sprint(
        project,
        name="S1",
        start=date(2026, 1, 5),
        finish=date(2026, 1, 18),
        completed_points=10,
    )
    _closed_sprint(
        project,
        name="S2",
        start=date(2026, 1, 19),
        finish=date(2026, 2, 1),
        completed_points=20,
    )
    assert compute_team_velocity_per_day(project.pk) is None


@pytest.mark.django_db
def test_velocity_computed_at_threshold(project: Project) -> None:
    # Three closed sprints, each two weeks (10 working days), with 10 / 20 / 30 points.
    # Rolling average per day = (1 + 2 + 3) / 3 = 2.0
    _closed_sprint(
        project,
        name="S1",
        start=date(2026, 1, 5),
        finish=date(2026, 1, 18),
        completed_points=10,
    )
    _closed_sprint(
        project,
        name="S2",
        start=date(2026, 1, 19),
        finish=date(2026, 2, 1),
        completed_points=20,
    )
    _closed_sprint(
        project,
        name="S3",
        start=date(2026, 2, 2),
        finish=date(2026, 2, 15),
        completed_points=30,
    )
    velocity = compute_team_velocity_per_day(project.pk)
    assert velocity is not None
    assert velocity == Decimal("2.000")


@pytest.mark.django_db
def test_velocity_exclude_specific_sprint(project: Project) -> None:
    # Four closed sprints; excluding one should drop it from the average.
    s1 = _closed_sprint(
        project,
        name="S1",
        start=date(2026, 1, 5),
        finish=date(2026, 1, 18),
        completed_points=10,
    )
    s2 = _closed_sprint(
        project,
        name="S2",
        start=date(2026, 1, 19),
        finish=date(2026, 2, 1),
        completed_points=20,
    )
    s3 = _closed_sprint(
        project,
        name="S3",
        start=date(2026, 2, 2),
        finish=date(2026, 2, 15),
        completed_points=30,
    )
    s4_exclude = _closed_sprint(
        project,
        name="S4",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=100,
    )
    # With s4 excluded the average drops back to 2.0 (10/10 + 20/10 + 30/10) / 3.
    velocity = compute_team_velocity_per_day(project.pk, exclude_sprint_id=s4_exclude.pk)
    assert velocity == Decimal("2.000")
    # Sanity: the un-excluded calc would include s4 and pull the average way up.
    velocity_all = compute_team_velocity_per_day(project.pk)
    assert velocity_all is not None and velocity_all > Decimal("2.000")
    _ = (s1, s2, s3)  # quiet "unused" linters; defined for fixture readability


@pytest.mark.django_db
def test_velocity_zero_returns_none(project: Project) -> None:
    """Three completed sprints with no points yields zero velocity → None."""
    for i in range(3):
        _closed_sprint(
            project,
            name=f"S{i}",
            start=date(2026, 1, 5 + i * 14),
            finish=date(2026, 1, 18 + i * 14),
            completed_points=0,
        )
    assert compute_team_velocity_per_day(project.pk) is None


# ---------------------------------------------------------------------------
# compute_velocity_suggestions
# ---------------------------------------------------------------------------


def _seed_baseline(project: Project) -> None:
    """Three prior completed sprints @ 20 points each / 10 working days = velocity 2.0/day."""
    for i in range(3):
        _closed_sprint(
            project,
            name=f"Prior{i}",
            start=date(2026, 1, 5 + i * 14),
            finish=date(2026, 1, 18 + i * 14),
            completed_points=20,
        )


@pytest.mark.django_db
def test_no_suggestions_without_history(project: Project) -> None:
    # Closing sprint with one task and no prior history.
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    Task.objects.create(
        project=project,
        name="T",
        duration=3,
        sprint=sprint,
        story_points=5,
    )
    touched = compute_velocity_suggestions(sprint.pk)
    assert touched == 0
    assert not VelocitySuggestion.objects.filter(sprint=sprint).exists()


@pytest.mark.django_db
def test_suggestion_created_for_task_with_story_points(project: Project) -> None:
    _seed_baseline(project)
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    task = Task.objects.create(
        project=project,
        name="T",
        duration=2,
        most_likely_duration=None,
        sprint=sprint,
        story_points=6,  # 6 / 2.0/day = 3 days
    )
    touched = compute_velocity_suggestions(sprint.pk)
    assert touched == 1
    sugg = VelocitySuggestion.objects.get(task=task, sprint=sprint)
    assert sugg.suggested_duration == 3
    assert sugg.team_velocity_per_day == Decimal("2.000")
    assert sugg.flag_for_review is False
    assert sugg.is_pending


@pytest.mark.django_db
def test_no_suggestion_when_already_matches(project: Project) -> None:
    _seed_baseline(project)
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    # Story points 6, velocity 2.0 → suggested 3, which equals the existing estimate.
    Task.objects.create(
        project=project,
        name="T",
        duration=2,
        most_likely_duration=3,
        sprint=sprint,
        story_points=6,
    )
    touched = compute_velocity_suggestions(sprint.pk)
    assert touched == 0
    assert not VelocitySuggestion.objects.filter(sprint=sprint).exists()


@pytest.mark.django_db
def test_no_suggestion_without_story_points(project: Project) -> None:
    _seed_baseline(project)
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    Task.objects.create(
        project=project,
        name="T",
        duration=2,
        sprint=sprint,
        story_points=None,
    )
    Task.objects.create(
        project=project,
        name="T2",
        duration=2,
        sprint=sprint,
        story_points=0,
    )
    touched = compute_velocity_suggestions(sprint.pk)
    assert touched == 0


@pytest.mark.django_db
def test_idempotent_on_pending_suggestion(project: Project) -> None:
    _seed_baseline(project)
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    task = Task.objects.create(
        project=project,
        name="T",
        duration=2,
        most_likely_duration=None,
        sprint=sprint,
        story_points=6,
    )
    compute_velocity_suggestions(sprint.pk)
    # Second call refreshes the pending row but does not create a duplicate.
    compute_velocity_suggestions(sprint.pk)
    assert VelocitySuggestion.objects.filter(task=task, sprint=sprint).count() == 1


@pytest.mark.django_db
def test_does_not_overwrite_accepted_decision(project: Project) -> None:
    _seed_baseline(project)
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    task = Task.objects.create(
        project=project,
        name="T",
        duration=2,
        most_likely_duration=None,
        sprint=sprint,
        story_points=6,
    )
    # Seed a previously-accepted suggestion at a different value.
    accepted = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=99,
        team_velocity_per_day=Decimal("9.999"),
        accepted_at=timezone.now(),
    )
    compute_velocity_suggestions(sprint.pk)
    accepted.refresh_from_db()
    # Audit values from the accepted decision survive — the service refuses
    # to clobber the historical record.
    assert accepted.suggested_duration == 99
    assert accepted.team_velocity_per_day == Decimal("9.999")


@pytest.mark.django_db
def test_flag_for_review_in_suggest_approve_mode(project: Project) -> None:
    project.estimation_mode = EstimationMode.SUGGEST_APPROVE
    project.save(update_fields=["estimation_mode"])
    _seed_baseline(project)
    sprint = _closed_sprint(
        project,
        name="Close",
        start=date(2026, 2, 16),
        finish=date(2026, 3, 1),
        completed_points=10,
    )
    Task.objects.create(
        project=project,
        name="T",
        duration=2,
        most_likely_duration=None,
        sprint=sprint,
        story_points=6,
    )
    compute_velocity_suggestions(sprint.pk)
    sugg = VelocitySuggestion.objects.get(sprint=sprint)
    assert sugg.flag_for_review is True


@pytest.mark.django_db
def test_no_op_on_non_completed_sprint(project: Project) -> None:
    """Defensive: service is a no-op when called on a non-completed sprint."""
    sprint = Sprint.objects.create(
        project=project,
        name="Open",
        start_date=date(2026, 2, 16),
        finish_date=date(2026, 3, 1),
        state=SprintState.ACTIVE,
    )
    Task.objects.create(
        project=project,
        name="T",
        duration=2,
        sprint=sprint,
        story_points=6,
    )
    touched = compute_velocity_suggestions(sprint.pk)
    assert touched == 0


@pytest.mark.django_db
def test_threshold_constant(project: Project) -> None:
    """Sanity: ADR-0065 requires a 3-sprint minimum."""
    assert MIN_CLOSED_SPRINTS_FOR_SUGGESTION == 3
