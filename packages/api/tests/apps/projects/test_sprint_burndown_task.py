"""Execution coverage for the nightly burndown Beat task.

`test_sprint_burndown.py` covers the inline service (`upsert_burndown_for_sprint`);
this file covers the Beat task that iterates active sprints and swallows
per-sprint errors so one bad sprint cannot stale every other chart (#1034).
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintBurnSnapshot,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.tasks import update_sprint_burndown_snapshots


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> object:
    """Bypass the Redis SET NX lock so the idempotent_task wrapper runs inline."""
    mock_client = MagicMock()
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _sprint(project: Project, name: str, state: str) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=state,
        committed_points=10,
        committed_task_count=1,
    )


def test_snapshots_only_active_sprints_for_yesterday(project: Project) -> None:
    yesterday = timezone.localdate() - timedelta(days=1)
    active_a = _sprint(project, "A", SprintState.ACTIVE)
    active_b = _sprint(project, "B", SprintState.ACTIVE)
    planned = _sprint(project, "P", SprintState.PLANNED)
    completed = _sprint(project, "C", SprintState.COMPLETED)
    for s in (active_a, active_b, planned, completed):
        Task.objects.create(
            project=project, name=f"t-{s.name}", duration=1, sprint=s, story_points=10
        )

    update_sprint_burndown_snapshots.run()

    # Active sprints get a row stamped for yesterday...
    assert SprintBurnSnapshot.objects.filter(sprint=active_a, snapshot_date=yesterday).exists()
    assert SprintBurnSnapshot.objects.filter(sprint=active_b, snapshot_date=yesterday).exists()
    # ...planned and completed sprints are skipped entirely.
    assert not SprintBurnSnapshot.objects.filter(sprint=planned).exists()
    assert not SprintBurnSnapshot.objects.filter(sprint=completed).exists()


def test_skips_soft_deleted_active_sprints(project: Project) -> None:
    live = _sprint(project, "live", SprintState.ACTIVE)
    deleted = _sprint(project, "deleted", SprintState.ACTIVE)
    Sprint.objects.filter(pk=deleted.pk).update(is_deleted=True)

    update_sprint_burndown_snapshots.run()

    assert SprintBurnSnapshot.objects.filter(sprint=live).exists()
    assert not SprintBurnSnapshot.objects.filter(sprint=deleted).exists()


def test_continues_after_a_per_sprint_failure(project: Project) -> None:
    """A single failing sprint must not abort the sweep for the rest."""
    _sprint(project, "A", SprintState.ACTIVE)
    _sprint(project, "B", SprintState.ACTIVE)

    with patch(
        "trueppm_api.apps.projects.services.upsert_burndown_for_sprint",
        side_effect=[RuntimeError("boom"), None],
    ) as upsert:
        # The task swallows the first error and keeps going — no exception out.
        update_sprint_burndown_snapshots.run()

    # Both active sprints were attempted despite the first one raising.
    assert upsert.call_count == 2
