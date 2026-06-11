"""Tests for the server-owned ``is_stalled`` verdict + ``dwell_days`` fact (#992).

A task is *stalled* when it has sat in its current status column for more than 3
days AND is not yet complete (``percent_complete < 100``). ``dwell_days`` is the raw
fact (full days since ``status_changed_at``) exposed alongside the verdict so an
MCP/headless client can re-threshold (ADR-0115), mirroring the ``spi`` / ``spi_band``
fact-plus-verdict precedent.

The methods read only ``status_changed_at``, ``percent_complete``, and the current
time — no DB — so these exercise the policy directly on in-memory Task instances.
"""

from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.projects.serializers import TaskSerializer


def _task(percent_complete: float, entered_days_ago: int | None) -> Task:
    """Build an in-memory Task whose status column was entered N days ago.

    ``entered_days_ago=None`` leaves ``status_changed_at`` unstamped (legacy / never
    moved); a positive int sets it that many days in the past.
    """
    task = Task(name="T", duration=10, percent_complete=percent_complete)
    if entered_days_ago is not None:
        task.status_changed_at = timezone.now() - timedelta(days=entered_days_ago)
    return task


def test_dwell_none_when_never_stamped() -> None:
    ser = TaskSerializer()
    task = _task(percent_complete=50, entered_days_ago=None)
    assert ser.get_dwell_days(task) is None
    assert ser.get_is_stalled(task) is False


def test_dwell_days_counts_full_days() -> None:
    ser = TaskSerializer()
    task = _task(percent_complete=50, entered_days_ago=5)
    assert ser.get_dwell_days(task) == 5


def test_not_stalled_within_threshold() -> None:
    """At or below 3 days dwell, an incomplete task is not yet stalled."""
    ser = TaskSerializer()
    task = _task(percent_complete=40, entered_days_ago=3)
    assert ser.get_is_stalled(task) is False


def test_stalled_past_threshold_when_incomplete() -> None:
    """More than 3 days in-column and not complete ⇒ stalled."""
    ser = TaskSerializer()
    task = _task(percent_complete=40, entered_days_ago=4)
    assert ser.get_is_stalled(task) is True


def test_complete_task_is_never_stalled() -> None:
    """A finished card sitting in DONE for weeks is finished, not stalled."""
    ser = TaskSerializer()
    task = _task(percent_complete=100, entered_days_ago=30)
    assert ser.get_is_stalled(task) is False
    # The raw dwell fact is still reported for a complete task.
    assert ser.get_dwell_days(task) == 30
