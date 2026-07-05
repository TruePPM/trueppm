"""Synthesize ProjectForecastSnapshot history for a sample project (#376, ADR-0211).

The forecast-trend chart (#368) reads ``scheduling.ProjectForecastSnapshot`` — the
continuous, project-grain record of how the whole-project forecast drifts over time
(ADR-0154). A freshly-loaded sample has zero snapshots, so the chart is empty until
the first CPM recompute; the differentiator ("look at this red trend line") never
lands on day one.

Rather than hand-author ~60 rows per project, a seed encodes *drift parameters* (a
per-project ``forecast_history`` block, see ``seed_v2.json``): a window length, a
fixed ``commitment_finish``, and start→end dates for the CPM spine and each Monte
Carlo percentile. This module walks the window one day at a time and interpolates
each series linearly from its start date to its end date, so the demo shows a
forecast that *slipped right* over two months while the promise held — the exact
shape a PM recognizes.

Why the drift math is honest, not arbitrary:

* ``cpm_finish`` walks ``cpm_start`` → ``cpm_end`` (later): the deterministic schedule
  spine slipping as work took longer than planned.
* ``total_float_days`` is derived, not authored: ``(commitment_finish - cpm_finish)``
  each day. As the CPM finish drifts past the fixed commitment, float crosses zero
  and goes negative — schedule *pressure* becomes visible, not just the date.
* The P50/P80/P95 band walks its own start→end, staying ordered (p50 ≤ p80 ≤ p95)
  and to the right of the CPM finish — the probabilistic tail a demo needs.

Determinism: the per-series jitter is seeded on ``(program_code, project slug)`` so a
re-import (the loader wipes-and-recreates) reproduces the identical trend. The jitter
is small (±1 day) and never allowed to reverse the overall monotonic drift — a demo
trend that wobbles backward reads as noise, not slip.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from trueppm_api.apps.projects.seed.reldates import resolve_date
from trueppm_api.apps.scheduling.models import (
    ForecastSnapshotTrigger,
    ProjectForecastSnapshot,
)

# Backfilled snapshots are captured at local noon on their historical day — a
# stable, timezone-neutral hour so ordering by captured_at is unambiguous and the
# newest row sits on the anchor (import day), matching a live daily-floor capture.
_CAPTURE_HOUR = 12


@dataclass(frozen=True)
class _Series:
    """One drifting date series resolved to concrete endpoints."""

    start: date
    end: date

    def at(self, frac: float, jitter_days: int) -> date:
        """Interpolate start→end at ``frac`` ∈ [0,1], nudged by ``jitter_days``.

        The jitter perturbs the *day within the window* but the linear trend
        dominates, so the series still drifts start→end overall.
        """
        span = (self.end - self.start).days
        offset = round(frac * span) + jitter_days
        return self.start + timedelta(days=offset)


def _resolve(spec: dict[str, Any], key: str, anchor: date) -> date | None:
    value = spec.get(key)
    # Forecast dates are values, not scheduled working days, so never weekend-snap.
    return resolve_date(value, anchor=anchor, snap=False) if value else None


def backfill_forecast_history(
    project: Any,
    spec: dict[str, Any],
    *,
    anchor: date,
    program_code: str,
    project_slug: str,
    task_count: int,
    tz: Any = None,
) -> list[ProjectForecastSnapshot]:
    """Create one ``ProjectForecastSnapshot`` per day across the spec's window.

    Args:
        project: the ``Project`` the snapshots belong to.
        spec: the seed ``forecast_history`` block (already schema-validated).
        anchor: the import anchor; the newest snapshot lands on this day and the
            window runs backward ``days-1`` days from it.
        program_code: with ``project_slug``, seeds the deterministic jitter. Both
            are stable file-local identifiers (not DB pks, which the wipe-and-recreate
            loader re-mints on every import), so a reload reproduces the same trend.
        project_slug: the seed's stable slug for this project (see ``program_code``).
        task_count: the project's task count, held constant across the window as
            ``task_count`` while ``completed_task_count`` ramps up.
        tz: program timezone for the backdated ``captured_at`` (defaults to UTC).

    Returns:
        The created rows (newest last), so a caller/test can assert on them.
    """
    days = int(spec["days"])
    tzinfo = tz or ZoneInfo("UTC")
    rng = random.Random(f"{program_code}:{project_slug}:forecast")

    commitment = resolve_date(spec["commitment_finish"], anchor=anchor, snap=False)
    cpm = _Series(
        _resolve(spec, "cpm_start", anchor),  # type: ignore[arg-type]
        _resolve(spec, "cpm_end", anchor),  # type: ignore[arg-type]
    )
    # MC band is all-or-none (schema documents it); treat a missing p50_start as
    # "no MC history" and leave every percentile null — a truthful flat MC line.
    has_mc = spec.get("p50_start") is not None
    p50 = _mc_series(spec, "p50", anchor) if has_mc else None
    p80 = _mc_series(spec, "p80", anchor) if has_mc else None
    p95 = _mc_series(spec, "p95", anchor) if has_mc else None
    mc_iterations = spec.get("mc_iterations") if has_mc else None
    completion_ratio = float(spec.get("completion_ratio", 0.5))
    completed_final = round(completion_ratio * task_count)

    rows: list[ProjectForecastSnapshot] = []
    captured: list[datetime] = []
    for i in range(days):
        # Oldest first (i=0) → newest (i=days-1, on the anchor). frac drives every
        # series from its start (oldest) to its end (newest).
        frac = i / (days - 1) if days > 1 else 1.0
        day = anchor - timedelta(days=days - 1 - i)
        # Small, deterministic per-day jitter; the linear trend still dominates so
        # the drift never visually reverses.
        cpm_finish = cpm.at(frac, rng.randint(-1, 1))
        row = ProjectForecastSnapshot(
            project=project,
            triggered_by=ForecastSnapshotTrigger.RECOMPUTE,
            cpm_finish=cpm_finish,
            # Derived pressure: positive early, negative once the slip eats the
            # commitment. This is what makes "float went red" visible in history.
            total_float_days=(commitment - cpm_finish).days,
            mc_p50_finish=p50.at(frac, rng.randint(0, 1)) if p50 else None,
            mc_p80_finish=p80.at(frac, rng.randint(0, 1)) if p80 else None,
            mc_p95_finish=p95.at(frac, rng.randint(0, 1)) if p95 else None,
            mc_iterations=mc_iterations,
            task_count=task_count,
            completed_task_count=round(frac * completed_final),
        )
        rows.append(row)
        captured.append(datetime.combine(day, time(_CAPTURE_HOUR), tzinfo=tzinfo))

    # captured_at is auto_now_add, so bulk_create stamps now() regardless of any
    # value set on the instance; backdate it in a second pass (the replay module's
    # pattern for auto-stamped rows) so each snapshot sits on its historical day.
    ProjectForecastSnapshot.objects.bulk_create(rows)
    for row, when in zip(rows, captured, strict=True):
        row.captured_at = when
    ProjectForecastSnapshot.objects.bulk_update(rows, ["captured_at"])
    return rows


def _mc_series(spec: dict[str, Any], pct: str, anchor: date) -> _Series | None:
    start = _resolve(spec, f"{pct}_start", anchor)
    end = _resolve(spec, f"{pct}_end", anchor)
    if start is None or end is None:
        return None
    return _Series(start, end)
