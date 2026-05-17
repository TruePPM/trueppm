"""Model invariants for VelocitySuggestion (ADR-0065)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling.models import VelocitySuggestion

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
        completed_points=20,
    )


@pytest.fixture
def task(project: Project, sprint: Sprint) -> Task:
    return Task.objects.create(
        project=project,
        name="Build widget",
        duration=3,
        sprint=sprint,
        story_points=5,
    )


@pytest.mark.django_db
def test_create_default_pending(task: Task, sprint: Sprint) -> None:
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
    )
    assert sugg.accepted_at is None
    assert sugg.dismissed_at is None
    assert sugg.flag_for_review is False
    assert sugg.is_pending is True


@pytest.mark.django_db
def test_accepted_is_not_pending(task: Task, sprint: Sprint) -> None:
    user = User.objects.create_user(username="pm", password="pw")
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
        accepted_at=timezone.now(),
        accepted_by=user,
    )
    assert sugg.is_pending is False


@pytest.mark.django_db
def test_dismissed_is_not_pending(task: Task, sprint: Sprint) -> None:
    user = User.objects.create_user(username="pm", password="pw")
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
        dismissed_at=timezone.now(),
        dismissed_by=user,
    )
    assert sugg.is_pending is False


@pytest.mark.django_db
def test_unique_per_task_sprint(task: Task, sprint: Sprint) -> None:
    VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
    )
    with pytest.raises(IntegrityError):
        VelocitySuggestion.objects.create(
            task=task,
            sprint=sprint,
            suggested_duration=6,
            team_velocity_per_day=Decimal("0.833"),
        )


@pytest.mark.django_db
def test_cascade_on_task_delete(task: Task, sprint: Sprint) -> None:
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
    )
    task.delete()
    assert not VelocitySuggestion.objects.filter(pk=sugg.pk).exists()


@pytest.mark.django_db
def test_cascade_on_sprint_delete(task: Task, sprint: Sprint) -> None:
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
    )
    sprint.delete()
    assert not VelocitySuggestion.objects.filter(pk=sugg.pk).exists()


@pytest.mark.django_db
def test_str_contains_ids(task: Task, sprint: Sprint) -> None:
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
    )
    s = str(sugg)
    assert str(task.id) in s
    assert str(sprint.id) in s


@pytest.mark.django_db
def test_accepted_by_set_null_on_user_delete(task: Task, sprint: Sprint) -> None:
    user = User.objects.create_user(username="pm", password="pw")
    sugg = VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=4,
        team_velocity_per_day=Decimal("1.250"),
        accepted_at=timezone.now(),
        accepted_by=user,
    )
    user.delete()
    sugg.refresh_from_db()
    assert sugg.accepted_by is None
    assert sugg.accepted_at is not None  # Audit stamp survives the user
