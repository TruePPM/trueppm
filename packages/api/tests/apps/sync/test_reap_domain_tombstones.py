"""Tests for sync.reap_domain_tombstones — nightly hard-delete of stale tombstones.

The reaper calls ``_do_reap()`` (extracted for testability). Tests drive that
helper directly so they never touch the Redis lock.

Key behaviours verified:
- Soft-deleted rows in live projects are hard-deleted.
- Live (non-deleted) rows in the same project survive.
- The retention window is respected for models that have ``updated_at``
  (Risk, Sprint) — recently-deleted rows outlast the cutoff.
- Rows in archived or soft-deleted projects are left alone.
- The function returns a dict of ``{label: count}`` for every registered model.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    Task,
)
from trueppm_api.apps.sync.tasks import _do_reap

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def live_project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Live Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def archived_project(calendar: Calendar) -> Project:
    project = Project.objects.create(
        name="Archived Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )
    # Bypass auto_now restrictions to set is_archived without going through
    # the archive endpoint (which requires auth setup not needed here).
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    project.refresh_from_db()
    return project


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_task(project: Project, *, soft_delete: bool = False) -> Task:
    task = Task.objects.create(project=project, name="T", duration=1)
    if soft_delete:
        Task.objects.filter(pk=task.pk).update(is_deleted=True)
        task.refresh_from_db()
    return task


def _make_risk(project: Project, *, soft_delete: bool = False) -> Risk:
    risk = Risk.objects.create(project=project, title="R", probability=1, impact=1)
    if soft_delete:
        Risk.objects.filter(pk=risk.pk).update(is_deleted=True)
        risk.refresh_from_db()
    return risk


def _backdate_risk_updated_at(risk: Risk, days_ago: int) -> None:
    """Move a Risk's updated_at into the past to simulate age.

    Uses update() to bypass the auto_now enforcement on save().
    """
    Risk.objects.filter(pk=risk.pk).update(updated_at=timezone.now() - timedelta(days=days_ago))


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_deletes_old_tombstones
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_deletes_old_tombstones(live_project: Project) -> None:
    """Soft-deleted Task rows in a live project are hard-deleted.

    Task has no ``updated_at`` so there is no time-window restriction —
    every tombstone in a live project is eligible. Three deleted tasks should
    disappear; the one live task must survive untouched.
    """
    t1 = _make_task(live_project, soft_delete=True)
    t2 = _make_task(live_project, soft_delete=True)
    t3 = _make_task(live_project, soft_delete=True)
    live = _make_task(live_project, soft_delete=False)

    counts = _do_reap(override_days=90)

    remaining_ids = set(Task.objects.values_list("pk", flat=True))
    assert t1.pk not in remaining_ids, "tombstoned task t1 should be hard-deleted"
    assert t2.pk not in remaining_ids, "tombstoned task t2 should be hard-deleted"
    assert t3.pk not in remaining_ids, "tombstoned task t3 should be hard-deleted"
    assert live.pk in remaining_ids, "live task must not be deleted"
    assert counts["projects.task"] >= 3


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_respects_retention_window
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_respects_retention_window(live_project: Project) -> None:
    """Soft-deleted Risks younger than the retention window are NOT hard-deleted.

    Risk carries ``updated_at`` (auto_now=True), which soft_delete() refreshes
    via save(). A Risk soft-deleted 2 days ago must survive a 90-day window.
    An old Risk (updated 95 days ago) must be reaped.
    """
    recent_risk = _make_risk(live_project, soft_delete=True)
    # updated_at is already recent — leave it as-is.

    old_risk = _make_risk(live_project, soft_delete=True)
    _backdate_risk_updated_at(old_risk, days_ago=95)

    _do_reap(override_days=90)

    # The recently-soft-deleted Risk still exists.
    assert Risk.objects.filter(pk=recent_risk.pk).exists(), (
        "risk soft-deleted within the retention window should not be reaped"
    )
    # The old tombstone is gone.
    assert not Risk.objects.filter(pk=old_risk.pk).exists(), (
        "risk tombstone older than the retention window should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_skips_archived_projects
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_skips_archived_projects(
    archived_project: Project, live_project: Project
) -> None:
    """Tombstones whose project is archived are left in place.

    Archived projects may be restored; their tombstone history must be
    preserved so sync clients can reconstruct state after a restore.
    """
    archived_task = _make_task(archived_project, soft_delete=True)
    live_task = _make_task(live_project, soft_delete=True)

    # Use override_days=0 so any time-filtered model also clears its window;
    # Task has no time filter so archived vs live is the only distinguisher.
    _do_reap(override_days=0)

    assert Task.objects.filter(pk=archived_task.pk).exists(), (
        "tombstone in archived project must not be hard-deleted"
    )
    assert not Task.objects.filter(pk=live_task.pk).exists(), (
        "tombstone in live project should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_returns_counts
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_returns_counts(live_project: Project) -> None:
    """_do_reap returns a dict with model labels as keys and deletion counts as values.

    Use override_days=0 so all tombstones are within the eligible window
    regardless of their actual age.
    """
    # Two deleted Tasks + one deleted Risk.
    _make_task(live_project, soft_delete=True)
    _make_task(live_project, soft_delete=True)
    deleted_risk = _make_risk(live_project, soft_delete=True)
    _backdate_risk_updated_at(deleted_risk, days_ago=1)  # within window — stays if days=90

    counts = _do_reap(override_days=0)

    # Must be a dict with at least the Task and Risk labels.
    assert isinstance(counts, dict), "return value must be a dict"
    assert "projects.task" in counts, "Task label must be present in counts"
    assert "projects.risk" in counts, "Risk label must be present in counts"
    assert counts["projects.task"] == 2, "should have deleted exactly 2 Task tombstones"
    # Risk is deleted because override_days=0 makes the cutoff == now,
    # so updated_at (which is near-now) falls before the cutoff only when
    # we force override_days=0 (cutoff = now - 0 days = now).
    # Use >= 1 instead of == 1 to be robust against race conditions.
    assert counts["projects.risk"] >= 1, "should have deleted at least 1 Risk tombstone"
    # Sprint and Dependency labels must also appear (with zero counts is fine).
    assert "projects.sprint" in counts
    assert "projects.dependency" in counts
