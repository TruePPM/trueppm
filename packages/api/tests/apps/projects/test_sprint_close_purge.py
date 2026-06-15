"""Execution coverage for the sprint-close-request retention purge.

`purge_sprint_close_requests` deletes terminal (COMPLETED/FAILED) outbox rows
older than 7 days. Without a test, a drift in the cutoff or status predicate
would either let rows accumulate forever or delete live in-flight requests
(#1034). The analogous purge_old_schedule_requests is already covered.
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
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
)
from trueppm_api.apps.projects.tasks import purge_sprint_close_requests


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
def sprint(db: object) -> Sprint:
    cal = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )


def _request(sprint: Sprint, status: str, age_days: int) -> SprintCloseRequest:
    """Create a close request and backdate requested_at (auto_now_add on insert)."""
    req = SprintCloseRequest.objects.create(sprint=sprint, status=status)
    backdated = timezone.now() - timedelta(days=age_days)
    SprintCloseRequest.objects.filter(pk=req.pk).update(requested_at=backdated)
    return req


def test_purges_only_old_terminal_requests(sprint: Sprint) -> None:
    old_completed = _request(sprint, SprintCloseRequestStatus.COMPLETED, age_days=8)
    old_failed = _request(sprint, SprintCloseRequestStatus.FAILED, age_days=30)
    recent_completed = _request(sprint, SprintCloseRequestStatus.COMPLETED, age_days=2)
    old_pending = _request(sprint, SprintCloseRequestStatus.PENDING, age_days=30)

    purge_sprint_close_requests.run()

    remaining = set(SprintCloseRequest.objects.values_list("pk", flat=True))
    # Old terminal rows are gone...
    assert old_completed.pk not in remaining
    assert old_failed.pk not in remaining
    # ...recent terminal rows and any non-terminal (in-flight) row survive.
    assert recent_completed.pk in remaining
    assert old_pending.pk in remaining


def test_purge_is_a_noop_when_nothing_is_old_enough(sprint: Sprint) -> None:
    recent = _request(sprint, SprintCloseRequestStatus.COMPLETED, age_days=1)
    purge_sprint_close_requests.run()
    assert SprintCloseRequest.objects.filter(pk=recent.pk).exists()
