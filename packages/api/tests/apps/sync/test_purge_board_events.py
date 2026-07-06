"""Tests for sync.purge_board_events — the WS replay-buffer reaper (ADR-0236, #321).

Mirrors test_reap_domain_tombstones: exercises the extracted ``_do_purge_board_events``
business logic (age cutoff, dry-run, override window) rather than the thin Celery
wrapper, so the retention behavior is tested without a broker.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.sync.models import BoardEvent
from trueppm_api.apps.sync.tasks import _do_purge_board_events


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Purge Proj", start_date=date(2026, 1, 1), calendar=calendar)


def _event_aged(project: Project, hours_old: float) -> BoardEvent:
    """Create a BoardEvent then backdate its auto_now_add created_at."""
    row = BoardEvent.objects.create(project=project, event_type="task_created", payload={})
    BoardEvent.objects.filter(pk=row.pk).update(
        created_at=timezone.now() - timedelta(hours=hours_old)
    )
    return row


@pytest.mark.django_db
def test_purge_deletes_rows_older_than_window(project: Project) -> None:
    """Rows past TRUEPPM_BOARD_EVENT_RETENTION_HOURS (default 24h) are deleted; fresh ones kept."""
    old = _event_aged(project, hours_old=48)
    fresh = _event_aged(project, hours_old=1)

    deleted = _do_purge_board_events()

    assert deleted == 1
    assert not BoardEvent.objects.filter(pk=old.pk).exists()
    assert BoardEvent.objects.filter(pk=fresh.pk).exists()


@pytest.mark.django_db
def test_purge_dry_run_counts_without_deleting(project: Project) -> None:
    """dry_run returns the eligible count and leaves the rows in place."""
    _event_aged(project, hours_old=48)
    _event_aged(project, hours_old=36)

    count = _do_purge_board_events(dry_run=True)

    assert count == 2
    assert BoardEvent.objects.count() == 2


@pytest.mark.django_db
def test_purge_override_window_shortens_retention(project: Project) -> None:
    """override_value forces a hypothetical window, ignoring the settings default."""
    _event_aged(project, hours_old=3)

    # Default 24h keeps a 3h-old row; a 1h override reaps it.
    assert _do_purge_board_events(dry_run=True) == 0
    assert _do_purge_board_events(override_value=1) == 1
