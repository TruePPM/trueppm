"""Roll a summary task's CPM row up from its leaf results (ADR-0105, #5010).

:func:`~trueppm_scheduler.schedule` schedules leaves only: summary tasks are
grouping nodes, removed by :func:`~trueppm_scheduler.expand_summary_dependencies`
before the pass. A summary's dates and float are therefore *derived* from the
leaves under it, and that derivation is a scheduling rule — which float a summary
reports decides whether a WBS group reads as critical — so it lives beside the
engine that produced the leaf values rather than in each embedder.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import timedelta

from trueppm_scheduler.models import Task

__all__ = ["roll_up_summary"]


def roll_up_summary(
    task_id: str, leaves: Iterable[Task], *, name: str | None = None
) -> Task | None:
    """Derive a summary task's scheduled row from its leaves' scheduled rows.

    The rule, field by field:

    - ``early_start`` / ``scheduled_start`` / ``late_start``: the earliest leaf
      value (``scheduled_start`` falls back to ``early_start``, ``late_start`` to
      the rolled ``early_start``, when no leaf carries one).
    - ``early_finish`` / ``late_finish``: the latest leaf value (``late_finish``
      falls back to the rolled ``early_finish``).
    - ``total_float``: the tightest leaf float, because a group is only as
      flexible as its least flexible piece of work; zero when no leaf has one.
    - ``free_float``: zero. A summary has no successors of its own, so it has no
      slack to report beyond its leaves'.
    - ``is_critical``: ``True`` if any leaf is critical.

    Args:
        task_id: The summary task's id, copied to the returned row.
        leaves: The scheduled leaf rows under the summary (for example the
            ``ScheduleResult.tasks`` entries whose ids
            :func:`~trueppm_scheduler.collect_leaves` returns).
        name: The returned row's name; defaults to ``task_id``.

    Returns:
        A zero-duration :class:`Task` carrying the rolled-up values, or ``None``
        when no leaf has both an ``early_start`` and an ``early_finish`` — a
        half-populated row would describe a bar with no span.
    """
    leaf_rows = list(leaves)
    es_dates = [t.early_start for t in leaf_rows if t.early_start is not None]
    ef_dates = [t.early_finish for t in leaf_rows if t.early_finish is not None]
    if not es_dates or not ef_dates:
        return None

    ls_dates = [t.late_start for t in leaf_rows if t.late_start is not None]
    lf_dates = [t.late_finish for t in leaf_rows if t.late_finish is not None]
    ss_dates = [t.scheduled_start for t in leaf_rows if t.scheduled_start is not None]
    floats = [t.total_float for t in leaf_rows if t.total_float is not None]

    summary = Task(id=task_id, name=task_id if name is None else name, duration=timedelta(days=0))
    summary.early_start = min(es_dates)
    summary.early_finish = max(ef_dates)
    summary.late_start = min(ls_dates) if ls_dates else summary.early_start
    summary.late_finish = max(lf_dates) if lf_dates else summary.early_finish
    summary.scheduled_start = min(ss_dates) if ss_dates else summary.early_start
    summary.total_float = min(floats) if floats else timedelta(days=0)
    summary.free_float = timedelta(days=0)
    summary.is_critical = any(t.is_critical for t in leaf_rows)
    return summary
