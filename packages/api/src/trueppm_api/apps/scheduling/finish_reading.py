"""Compare two project finishes in working time, not by their shown day (#4178).

``ScheduleResult.project_finish`` and a milestone's ``early_finish`` are *days*,
and the engine chooses which edge of that day a zero-duration milestone sits on
(``Task.milestone_at_day_end``, #4079). After #4173 a milestone that lands just
after non-working time is shown at the **start of the next working day**, while
one that follows work is shown at the **end of its day**. The end of Friday and
the start of the following Monday are the same position in working time, so the
shown finish can jump Friday -> Monday while the working-time finish does not move
at all. Diffing the two shown days as calendar days reports that as a three-day
slip — a phantom.

This module turns a shown finish ``(day, at_day_start)`` into the day whose *end*
is the same position in working time — a start-of-day finish becomes the end of
the last working day before it — and diffs those. A finish whose shown day hops
non-working time without moving in working time therefore gets a delta of zero.
Every delta is still reported in calendar days, so the unit of
``end_date_shift_threshold_days`` and of the activity feed's ``finish +Nd`` does
not change, and a finish that is the end of its day diffs exactly as before.

Why the reading is reconstructed here rather than read from the engine: the engine
computes the project's finish *instant* internally but exposes only the day and the
per-task ``milestone_at_day_end`` flag, and #4178 is scoped to consumers, not to the
engine's public surface.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

#: A shown finish: ``(day, at_day_start)``. ``at_day_start`` True means the finish
#: is the *start* of ``day`` (a start-of-day milestone), False the end of it, and
#: ``None`` that the reading is unknown — a snapshot row written before the reading
#: was recorded (see :func:`finish_shift_days`).
Finish = tuple[date, bool | None]

#: The ``Task`` columns :func:`task_finish_at_day_start` reads. Name them in any
#: ``.only()`` / ``.values()`` that feeds it, or each deferred read is a query.
FINISH_READING_FIELDS: tuple[str, ...] = (
    "is_milestone",
    "milestone_at_day_end",
    "actual_start",
    "actual_finish",
    "percent_complete",
)


def task_finish_at_day_start(task: Any, *, milestone_at_day_end: bool | None = None) -> bool:
    """Whether a task's ``early_finish`` is the *start* of that day.

    Mirrors the engine's own rule (``trueppm_scheduler.engine._finish_instant``):
    only a network-placed milestone the engine did not put at the end of its day
    (``milestone_at_day_end`` False) ends at the start of its day. Work always ends
    at the end of its finish day, and so does a milestone pinned by recorded
    actuals — the engine lays it out as ordinary work and resets
    ``milestone_at_day_end`` to False, so the flag alone would misread it. Pinned
    means complete (``actual_finish`` set, or ``percent_complete`` at 100) with an
    actual date to anchor on (``_pinned_placement``).

    ``milestone_at_day_end`` overrides the task's own flag, for reading a finish
    the task held before a recalculation overwrote it.

    ``task`` is a Django ``Task`` (milestone = ``is_milestone``) or an engine
    ``trueppm_scheduler.Task`` from a ``ScheduleResult``, which has no
    ``is_milestone`` and is a milestone when its ``duration`` is zero.
    """
    if milestone_at_day_end is None:
        milestone_at_day_end = bool(getattr(task, "milestone_at_day_end", False))
    is_milestone = getattr(task, "is_milestone", None)
    if is_milestone is None:
        is_milestone = getattr(task, "duration", None) == timedelta(0)
    if not is_milestone or milestone_at_day_end:
        return False
    actual_finish = getattr(task, "actual_finish", None)
    actual_start = getattr(task, "actual_start", None)
    complete = actual_finish is not None or (getattr(task, "percent_complete", 0) or 0) >= 100
    pinned = complete and (actual_finish is not None or actual_start is not None)
    return not pinned


def values_finish_at_day_start(row: Mapping[str, Any]) -> bool | None:
    """:func:`task_finish_at_day_start` for a ``Task`` ``.values()`` row (#4197).

    ``None`` when the row has no ``early_finish`` — there is no finish to read an
    edge of. The row must carry :data:`FINISH_READING_FIELDS`. Used at baseline
    capture, whose task read is a ``.values()`` query.
    """
    if row.get("early_finish") is None:
        return None
    return task_finish_at_day_start(SimpleNamespace(**{f: row[f] for f in FINISH_READING_FIELDS}))


def latest_finish(rows: Iterable[tuple[date | None, bool, Any]]) -> Finish | None:
    """The project finish, with its reading, from ``(early_finish, at_day_start, wbs_path)`` rows.

    The day is the latest ``early_finish``, exactly as ``project_finish`` is. It is
    the start of that day only when every task finishing that day does so at its
    start. A summary row carries its children's rolled-up finish but not their
    reading, so it is dropped when another row on the same day sits inside its WBS
    subtree — a summary's finish is always one of its leaves', so this loses
    nothing. Returns ``None`` when no row has a finish.
    """
    on_day: list[tuple[bool, str | None]] = []
    day: date | None = None
    for finish, at_start, wbs_path in rows:
        if finish is None:
            continue
        path = str(wbs_path) if wbs_path else None
        if day is None or finish > day:
            day, on_day = finish, [(at_start, path)]
        elif finish == day:
            on_day.append((at_start, path))
    if day is None:
        return None
    # Every proper ancestor of a path on the day: O(rows x depth), so a project
    # whose whole plan finishes on one day does not go quadratic.
    ancestors: set[str] = set()
    for _, p in on_day:
        if p:
            parts = p.split(".")
            ancestors.update(".".join(parts[:i]) for i in range(1, len(parts)))
    leaves = [at_start for at_start, p in on_day if not (p and p in ancestors)]
    return day, bool(leaves) and all(leaves)


def schedule_result_finish(result: Any) -> Finish | None:
    """``ScheduleResult.project_finish`` with its reading.

    A ``ScheduleResult`` holds leaf tasks only (summaries are stripped before the
    pass), so no WBS pruning is needed.
    """
    return latest_finish((t.early_finish, task_finish_at_day_start(t), None) for t in result.tasks)


def working_time_end_day(finish: Finish, calendar: Any) -> date:
    """The day whose end is the same working-time position as ``finish``.

    The end of a day is that day. The start of a day is the end of the last
    working day before it — the start of a Monday is the end of the Friday before
    it. A finish recorded on a non-working day (a task pinned to a Saturday actual
    finish) is kept as recorded: it is a fact the user entered, not a reading the
    engine chose, and it cannot hop a weekend between two recalculations.
    """
    from trueppm_scheduler.engine import _prev_working_day

    day, at_day_start = finish
    if not at_day_start:
        return day
    return _prev_working_day(day - timedelta(days=1), calendar)


def finish_shift_days(prior: Finish, new: Finish, calendar: Any | None) -> int:
    """Signed calendar-day move of the project finish in working time.

    Positive means the finish moved later. Zero for the Friday-end ->
    Monday-start jump across a weekend that the shown day makes with no move in
    working time (#4178). ``calendar`` is the project's
    composed scheduler ``Calendar``; with ``None`` it falls back to the plain
    shown-day difference.

    An unknown reading (``None``, a row written before the reading was recorded)
    cannot be told apart from either edge of its day. When the two shown days are
    equal the finish is taken as unmoved — otherwise the first comparison after an
    upgrade would read a start-of-day milestone against an assumed end of the same
    day and report a phantom three-day pull-in. When the days differ, the unknown
    side is read as the end of its day, which is how every finish was shown before
    #4079. An install that ran an untagged main image from after #4079 (which could
    already show a start-of-day milestone) but before this field may therefore
    misread that one post-upgrade comparison by up to the weekend or holiday gap.
    """
    unknown = prior[1] is None or new[1] is None
    if calendar is None or (unknown and prior[0] == new[0]):
        return (new[0] - prior[0]).days
    prior_known: Finish = (prior[0], bool(prior[1]))
    new_known: Finish = (new[0], bool(new[1]))
    return (
        working_time_end_day(new_known, calendar) - working_time_end_day(prior_known, calendar)
    ).days
