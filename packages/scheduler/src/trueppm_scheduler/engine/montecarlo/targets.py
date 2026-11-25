"""Per-task completion percentiles (#4135).

Reads the forward pass's per-run matrices, which :func:`monte_carlo` otherwise
reduces to one column maximum per run and drops. The collector is handed every chunk
once its columns are on the shared reference ruler; it draws nothing from the RNG,
so a run that asks for targets returns the same project percentiles and the same
tornado ranking as one that does not.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import date

import numpy as np

from trueppm_scheduler.engine.errors import InvalidScheduleInput
from trueppm_scheduler.engine.limits import MC_TARGET_CAP
from trueppm_scheduler.engine.results import Percentile, TargetForecast
from trueppm_scheduler.models import Project


def _validate_targets(project: Project, targets: object) -> list[str] | None:
    """``targets`` as a de-duplicated id list, or ``None`` when not requested.

    Raises :class:`InvalidScheduleInput` for a bare string, a non-string member, an id
    the project does not have, or more than ``MC_TARGET_CAP`` distinct ids.
    """
    if targets is None:
        return None
    if isinstance(targets, (str, bytes)) or not isinstance(targets, Sequence):
        raise InvalidScheduleInput("targets must be a sequence of task ids or None.")
    ids: list[str] = []
    seen: set[str] = set()
    for tid in targets:
        if not isinstance(tid, str):
            raise InvalidScheduleInput(f"targets must contain task id strings (got {tid!r:.40}).")
        if tid not in seen:
            seen.add(tid)
            ids.append(tid)
    if len(ids) > MC_TARGET_CAP:
        raise InvalidScheduleInput(
            f"targets lists {len(ids):,} tasks; at most MC_TARGET_CAP={MC_TARGET_CAP} "
            "may be requested in one simulation."
        )
    known = {t.id for t in project.tasks}
    missing = [tid for tid in ids if tid not in known]
    if missing:
        raise InvalidScheduleInput(f"targets name unknown task ids: {missing[:5]!r:.200}")
    return ids


class _TargetCollector:
    """Keeps the requested columns' per-run finishes across chunks (#4135).

    Two ``(runs, k)`` float64 matrices — the shown-day offset and the working-time
    position, both already on the reference ruler — so the memory is bounded by
    ``MC_TARGET_CAP`` columns, not by the project.
    """

    def __init__(self, ids: list[str], task_idx: dict[str, int], runs: int) -> None:
        self.ids = ids
        self.cols = np.asarray([task_idx[tid] for tid in ids], dtype=np.intp)
        self.shown = np.empty((runs, len(ids)), dtype=np.float64)
        self.position = np.empty((runs, len(ids)), dtype=np.float64)
        self._verbatim: dict[int, int] = {}  # column -> ordinal of its verbatim day

    def note_verbatim(self, verbatim_shown: dict[int, tuple[np.ndarray, int]]) -> None:
        """Record the columns this chunk shows on a non-working ``actual_start``.

        The offset index holds working days only, so such a column carries the working
        day before and the date itself has to floor the reading, as it floors the
        project finish (#4175). Runs not shown on that day finish after it, so one
        floor per column is exact.
        """
        for col, (_mask, ordinal) in verbatim_shown.items():
            self._verbatim[col] = ordinal

    def add(self, lo: int, hi: int, ef_ref: np.ndarray, wt_ref: np.ndarray) -> None:
        """Copy this chunk's target columns out before the chunk is dropped."""
        self.shown[lo:hi] = ef_ref[:, self.cols]
        self.position[lo:hi] = wt_ref[:, self.cols]

    def result(
        self,
        percentiles: Callable[[np.ndarray, np.ndarray, date | None], list[tuple[date, bool]]],
        to_date: Callable[[float, date | None], date],
        completed: dict[str, tuple[date, bool]],
    ) -> dict[str, TargetForecast]:
        """One :class:`TargetForecast` per target, in request order.

        ``percentiles(position, shown, floor)`` is the project-level reader, given the
        target's own finish floor (never the project's); ``to_date(offset, floor)``
        maps a shown offset to its day. ``completed`` maps a
        completed target to its recorded finish and edge-of-day reading, reported
        verbatim at every level: the offset ruler cannot hold a recorded finish on a
        non-working day.
        """
        out: dict[str, TargetForecast] = {}
        runs = self.shown.shape[0]
        for j, tid in enumerate(self.ids):
            pinned = completed.get(tid)
            if pinned is not None:
                reading = Percentile(pinned[0], pinned[1])
                out[tid] = TargetForecast(
                    task_id=tid,
                    percentiles={50: reading, 80: reading, 95: reading},
                    distribution=[pinned[0]] * runs,
                )
                continue
            ordinal = self._verbatim.get(int(self.cols[j]))
            floor = None if ordinal is None else date.fromordinal(ordinal)
            levels = percentiles(self.position[:, j], self.shown[:, j], floor)
            uniq, counts = np.unique(self.shown[:, j], return_counts=True)
            distribution: list[date] = []
            for offset, count in zip(uniq.tolist(), counts.tolist(), strict=True):
                distribution.extend([to_date(offset, floor)] * count)
            out[tid] = TargetForecast(
                task_id=tid,
                percentiles={
                    q: Percentile(d, s) for q, (d, s) in zip((50, 80, 95), levels, strict=True)
                },
                distribution=distribution,
            )
        return out
