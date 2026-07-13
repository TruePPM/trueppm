"""Cumulative project-span enforcement on the REST task-write path (#1862).

Per-task duration is bounded by the model field, but the CPM engine also rejects a
project whose task durations + dependency lags SUM past ``MAX_PROJECT_SPAN_DAYS``.
``TaskSerializer.validate`` / ``DependencySerializer.validate`` now surface that as
an actionable 400 at the write boundary, so ~11 max-duration tasks fail on the
write that would tip the sum over — rather than persisting and then breaking every
subsequent ``recalculate_schedule`` (run FAILED) and Monte Carlo run (400).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    MAX_PROJECT_SPAN_DAYS,
    MAX_TASK_DURATION_DAYS,
    Calendar,
    Project,
    Task,
)

User = get_user_model()


@contextmanager
def _no_side_effects() -> Iterator[None]:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        yield


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def pm_client(project: Project, db: object) -> APIClient:
    user = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _fill_project_to_near_cap(project: Project, tasks: int) -> None:
    """Create ``tasks`` max-duration tasks directly via the ORM (not gated)."""
    for i in range(tasks):
        Task.objects.create(project=project, name=f"T{i}", duration=MAX_TASK_DURATION_DAYS)


@pytest.mark.django_db
def test_create_task_pushing_span_over_cap_rejected(pm_client: APIClient, project: Project) -> None:
    # 10 max-duration tasks already sit just under the cap; the 11th tips it over.
    _fill_project_to_near_cap(project, 10)
    r = pm_client.post(
        "/api/v1/tasks/",
        {"name": "Overflow", "duration": MAX_TASK_DURATION_DAYS, "project": str(project.pk)},
        format="json",
    )
    assert r.status_code == 400, r.data
    assert "duration" in r.data
    assert "Project span too large" in " ".join(str(m) for m in r.data["duration"])
    assert not Task.objects.filter(name="Overflow").exists()


@pytest.mark.django_db
def test_create_task_within_cap_succeeds(pm_client: APIClient, project: Project) -> None:
    _fill_project_to_near_cap(project, 5)
    with _no_side_effects():
        r = pm_client.post(
            "/api/v1/tasks/",
            {"name": "Fits", "duration": 10, "project": str(project.pk)},
            format="json",
        )
    assert r.status_code == 201, r.data
    assert Task.objects.get(name="Fits").duration == 10


@pytest.mark.django_db
def test_unrelated_patch_not_blocked_by_preexisting_span(
    pm_client: APIClient, project: Project
) -> None:
    """A PATCH that does not change duration must not be blocked even if the
    project already exceeds the cap (the guard fires only on duration changes)."""
    _fill_project_to_near_cap(project, 11)  # already over-cap in aggregate
    task = Task.objects.filter(project=project).first()
    assert task is not None
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"name": "Renamed"},
            format="json",
        )
    assert r.status_code == 200, r.data


@pytest.mark.django_db
def test_span_cap_constant_matches_engine() -> None:
    from trueppm_scheduler.engine import MAX_PROJECT_SPAN_DAYS as ENGINE_CAP

    assert MAX_PROJECT_SPAN_DAYS == ENGINE_CAP
