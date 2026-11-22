"""A sprint close persists one milestone rollup event, however many tasks move.

The issue's premise was a per-task save in the close: ``_clear_sprint_ranks`` has
since moved to ``bulk_update_with_history``, which fires no ``post_save``, and a
carry-over to the backlog unlinks each task from the sprint, which the rollup
receiver skips. The per-task saves that remain are ``apply_carry_over``'s when the
incomplete tasks carry into a next sprint bound to the same milestone: each one
used to recompute the rollup and persist its own ``milestone_rollup_updated``
``BoardEvent``, before the close's own explicit recompute added one more. This pins
the end-to-end count through ``close_sprint`` on that path, with the real broadcast
and the persisted replay buffer, rather than a mocked broadcast.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.tasks import close_sprint
from trueppm_api.apps.sync.models import BoardEvent

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> Any:
    """Bypass the Redis SET NX lock so idempotent_task wrappers run inline."""
    mock_client = MagicMock()
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.valkey") as redis_module:
        redis_module.client.return_value = mock_client
        yield mock_client


def test_closing_a_20_task_milestone_sprint_persists_one_rollup_event(
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    owner = User.objects.create_user(username="closer", password="pw")
    project = Project.objects.create(name="Proj", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    milestone = Task.objects.create(
        project=project,
        name="MVP",
        duration=0,
        is_milestone=True,
        early_finish=date(2026, 4, 30),
        early_start=date(2026, 4, 30),
        milestone_at_day_end=True,
    )
    closing = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 6),
        finish_date=date(2026, 1, 20),
        state=SprintState.ACTIVE,
        committed_points=20,
        target_milestone=milestone,
    )
    following = Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 1, 21),
        finish_date=date(2026, 2, 3),
        state=SprintState.PLANNED,
        target_milestone=milestone,
    )
    for i in range(20):
        Task.objects.create(project=project, name=f"T{i}", duration=1, sprint=closing)
    req = SprintCloseRequest.objects.create(
        sprint=closing, requested_by=owner, carry_over_to=str(following.pk)
    )
    BoardEvent.objects.all().delete()

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED, req.error_message
    # Precondition: the carry-over really did move all 20 through per-task saves
    # into a sprint bound to the same milestone, so each save parked the rollup.
    assert Task.objects.filter(sprint=following).count() == 20
    assert BoardEvent.objects.filter(event_type="milestone_rollup_updated").count() == 1
