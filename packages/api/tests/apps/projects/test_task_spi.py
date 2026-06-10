"""Tests for the server-owned per-task SPI + band on TaskSerializer (#990).

SPI = earned% / planned%, where planned% is the fraction of the active-baseline
duration elapsed as of today. The verdict bands (≥0.95 on_track, ≥0.85 at_risk,
else behind) match the project-level SPI rollup and the board-card chip, so the
classification is identical wherever it renders.

The methods read only ``percent_complete``, the annotated ``baseline_start`` /
``baseline_finish`` overlay, and today's date — no DB — so these exercise the
formula directly on in-memory Task instances.
"""

from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.projects.serializers import TaskSerializer


def _task(percent_complete: float, start_offset: int | None, finish_offset: int | None) -> Task:
    """Build an in-memory Task with a baseline window relative to today.

    ``start_offset`` / ``finish_offset`` are day offsets from today (negative =
    past). ``None`` leaves the baseline attribute unset (no active baseline).
    """
    today = timezone.localdate()
    task = Task(name="T", duration=10, percent_complete=percent_complete)
    if start_offset is not None:
        task.baseline_start = today + timedelta(days=start_offset)  # type: ignore[attr-defined]
    if finish_offset is not None:
        task.baseline_finish = today + timedelta(days=finish_offset)  # type: ignore[attr-defined]
    return task


def test_spi_none_without_baseline() -> None:
    ser = TaskSerializer()
    task = _task(percent_complete=50, start_offset=None, finish_offset=None)
    assert ser.get_spi(task) is None
    assert ser.get_spi_band(task) is None


def test_spi_none_before_baseline_start() -> None:
    """A task that hasn't started per baseline has an undefined SPI (not zero)."""
    ser = TaskSerializer()
    task = _task(percent_complete=0, start_offset=5, finish_offset=15)
    assert ser.get_spi(task) is None
    assert ser.get_spi_band(task) is None


def test_spi_on_track_when_progress_matches_plan() -> None:
    """Half-elapsed (start -5, finish +5 ⇒ 50% planned), 50% done ⇒ SPI 1.0."""
    ser = TaskSerializer()
    task = _task(percent_complete=50, start_offset=-5, finish_offset=5)
    assert ser.get_spi(task) == 1.0
    assert ser.get_spi_band(task) == "on_track"


def test_spi_at_risk_band() -> None:
    """50% planned, 45% done ⇒ SPI 0.9 ⇒ at_risk (≥0.85, <0.95)."""
    ser = TaskSerializer()
    task = _task(percent_complete=45, start_offset=-5, finish_offset=5)
    assert ser.get_spi(task) == 0.9
    assert ser.get_spi_band(task) == "at_risk"


def test_spi_behind_band() -> None:
    """50% planned, 30% done ⇒ SPI 0.6 ⇒ behind (<0.85)."""
    ser = TaskSerializer()
    task = _task(percent_complete=30, start_offset=-5, finish_offset=5)
    assert ser.get_spi(task) == 0.6
    assert ser.get_spi_band(task) == "behind"


def test_spi_ahead_exceeds_one() -> None:
    """SPI > 1 is a genuine ahead-of-schedule signal, not capped."""
    ser = TaskSerializer()
    task = _task(percent_complete=80, start_offset=-5, finish_offset=5)
    # planned 50%, earned 80% ⇒ 1.6
    assert ser.get_spi(task) == 1.6
    assert ser.get_spi_band(task) == "on_track"


def test_planned_pct_capped_at_100_when_baseline_elapsed() -> None:
    """Baseline fully in the past ⇒ planned% caps at 100, so SPI == progress/100."""
    ser = TaskSerializer()
    task = _task(percent_complete=90, start_offset=-20, finish_offset=-10)
    assert ser.get_spi(task) == 0.9
    assert ser.get_spi_band(task) == "at_risk"
