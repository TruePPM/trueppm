"""Derivation provenance around zero-duration milestones (#4146, for #4079).

``test_milestone_instant.py`` proves the *engine* treats a milestone as an
instant. This file pins the **explanation** of that engine value — the surface
:mod:`trueppm_scheduler.derive` exposes to the API, to agents, and to anyone
asking "why is this date what it is".

Why it exists: the #4079 milestone-instant work added ~110 branches to
``derive.py`` that the suite *executed* but never *asserted on*, and the nightly
``scheduler:mutation`` score fell 96.6% -> 90.6% on ``main``. The pre-existing
assertion — the binding term's ``imposed_date`` equals the derived value — is
satisfied by many wrong derivations, because a mutant that picks the wrong term
usually picks one whose date still matches (the floor and the link both land on
the value). What it cannot survive is being told **which** term binds and what
every candidate looked like.

So each network below carries a golden table: one block per
``(task, quantity)``, naming the value and then every contribution as

``kind source dep_type lag imposed_date calendar_days_added slack_days B|.``

with ``-`` for an absent field and ``B`` marking ``is_binding``. This is a
snapshot, and it is deliberate: the derivation's whole contract is *which*
constraint it names, so there is nothing weaker to assert. It is not a snapshot
of an unchecked oracle, though — :func:`test_every_golden_value_is_the_engines`
re-derives every value straight off the ``ScheduleResult``, so a golden row can
never encode a date the engine does not report.

Each network targets a distinct milestone path:

* ``start_milestone`` — the instant comes from a floor, with no link at all;
* ``milestone_chain`` — a milestone whose predecessor is itself a milestone, so
  the anchor is the *instant*, not ``early_finish + 1``;
* ``two_preds`` — an FS and an SS term competing for one instant, which the
  ``(instant, start_display)`` key resolves and a plain date comparison cannot;
* ``finish_anchored`` — FF and SF links into a milestone (the end-of-day reading);
* ``saturday_milestone`` — a milestone on its own six-day calendar, so the
  predecessor's calendar (not the successor's) decides a finish-anchored bound;
* ``milestone_with_float`` — a milestone off the critical path;
* ``milestone_floors`` — an SNET and a data date competing with a link;
* ``milestone_on_a_saturday_actual`` — an instant pinned to a non-working day,
  so the milestone's own early date is not a working day at all.

Regenerating: these tables are engine output, so a deliberate change to
milestone semantics changes them. Rebuild a block by printing, for each task and
quantity, ``derive_value(...).contributions`` in the column order above — and
read the diff, because that diff is the semantic change.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Quantity,
    Task,
    derive_value,
    schedule,
)
from trueppm_scheduler.derive import Derivation, DerivationContribution

MON = date(2026, 1, 5)
SAT_CAL = Calendar(working_days=0b0111111)  # Mon-Sat


def _task(tid: str, days: int, **kwargs: object) -> Task:
    t = Task(id=tid, name=tid, duration=timedelta(days=days))
    for key, value in kwargs.items():
        setattr(t, key, value)
    return t


def _dep(
    pred: str, succ: str, dep_type: DependencyType = DependencyType.FS, lag: int = 0
) -> Dependency:
    return Dependency(pred, succ, dep_type=dep_type, lag=timedelta(days=lag))


def _project(tasks: list[Task], deps: list[Dependency], **kwargs: object) -> Project:
    kwargs.setdefault("calendar", Calendar())
    return Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=tasks,
        dependencies=deps,
        **kwargs,  # type: ignore[arg-type]
    )


def _networks() -> dict[str, Project]:
    """One project per milestone path exercised; see the module docstring."""
    return {
        "start_milestone": _project(
            [_task("M0", 0), _task("A", 3), _task("B", 2)],
            [_dep("M0", "A"), _dep("M0", "B", DependencyType.SS, 2)],
        ),
        "milestone_chain": _project(
            [_task("A", 4), _task("M1", 0), _task("M2", 0), _task("B", 3)],
            [_dep("A", "M1"), _dep("M1", "M2"), _dep("M2", "B", DependencyType.SS)],
        ),
        "two_preds": _project(
            [_task("A", 5), _task("C", 3), _task("M", 0), _task("B", 2)],
            [_dep("A", "M"), _dep("C", "M", DependencyType.SS, 4), _dep("M", "B")],
        ),
        "finish_anchored": _project(
            [_task("A", 5), _task("C", 2), _task("M", 0), _task("B", 3)],
            [
                _dep("A", "M", DependencyType.FF),
                _dep("C", "M", DependencyType.SF, 1),
                _dep("M", "B", DependencyType.FS),
            ],
        ),
        "saturday_milestone": _project(
            [_task("A", 5), _task("C", 2), _task("M", 0, calendar_id="sat"), _task("B", 2)],
            [
                _dep("A", "M", DependencyType.FS, 1),
                _dep("C", "M", DependencyType.FF),
                _dep("M", "B", DependencyType.FF),
            ],
            calendars={"sat": SAT_CAL},
        ),
        "milestone_with_float": _project(
            [_task("L", 10), _task("A", 2), _task("M", 0, calendar_id="sat"), _task("B", 2)],
            [_dep("A", "M"), _dep("M", "B")],
            calendars={"sat": SAT_CAL},
        ),
        "milestone_floors": _project(
            [
                _task("X", 1),
                _task("L", 8),
                _task("M", 0, planned_start=date(2026, 1, 10)),
                _task("Z", 2),
            ],
            [_dep("X", "M"), _dep("M", "Z", DependencyType.SS, 1)],
            status_date=date(2026, 1, 6),
        ),
        "milestone_on_a_saturday_actual": _project(
            [_task("L", 8), _task("M", 0, actual_start=date(2026, 1, 10)), _task("Z", 2)],
            [_dep("M", "Z")],
        ),
        # A milestone with no successors at all, and the last thing in the project:
        # its late window is seeded from the project's finish *instant*, which here
        # is a day earlier than the end of the finish day.
        "terminal_milestone": _project(
            [_task("L", 3), _task("M", 0, planned_start=date(2026, 1, 12))],
            [_dep("L", "M")],
        ),
        # Both links land the milestone on 2026-01-12 as a displayed day, but the
        # FS link proposes the later *instant*. The SS link is listed first, so a
        # derivation comparing displayed days hands the explanation to it.
        "instant_beats_display": _project(
            [_task("A", 6), _task("C", 1), _task("M", 0), _task("B", 2)],
            [_dep("C", "M", DependencyType.SS, 7), _dep("A", "M"), _dep("M", "B")],
        ),
    }


def _cell(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _row(contribution: DerivationContribution) -> str:
    """One contribution as the golden table's eight space-separated columns."""
    return " ".join(
        [
            contribution.kind,
            _cell(contribution.source_task_id),
            _cell(contribution.dep_type),
            _cell(contribution.lag_days),
            _cell(contribution.imposed_date),
            _cell(contribution.calendar_days_added),
            _cell(contribution.slack_days),
            "B" if contribution.is_binding else ".",
        ]
    )


def _render(derivation: Derivation) -> list[str]:
    return [_row(c) for c in derivation.contributions]


def _parse(table: str) -> dict[tuple[str, str], tuple[str, list[str]]]:
    """``"<task> <quantity> = <value>"`` headers, each followed by its indented terms."""
    parsed: dict[tuple[str, str], tuple[str, list[str]]] = {}
    key: tuple[str, str] | None = None
    for raw in table.strip().splitlines():
        line = raw.strip()
        if not line:
            continue
        if "=" in line and not raw.startswith("    "):
            head, value = line.split(" = ", 1)
            task_id, quantity = head.split(" ", 1)
            key = (task_id, quantity)
            parsed[key] = (value, [])
        else:
            assert key is not None, "a term line must follow a header line"
            parsed[key][1].append(" ".join(line.split()))
    return parsed


START_MILESTONE = """
M0 early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
M0 early_finish = 2026-01-05
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-05 - 0 B
M0 late_start = 2026-01-05
    project_finish - - - 2026-01-08 - - .
    successor_fs A FS 0 2026-01-06 0 - .
    successor_ss B SS 2 2026-01-05 0 - B
M0 late_finish = 2026-01-05
    project_finish - - - 2026-01-08 - - .
    successor_fs A FS 0 2026-01-06 0 - .
    successor_ss B SS 2 2026-01-05 0 - B
M0 total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
M0 free_float = 0
    successor_free_slack A FS 0 2026-01-05 - 0 .
    successor_free_slack B SS 2 2026-01-05 - 0 B
M0 scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M0 FS 0 2026-01-05 0 - B
A early_finish = 2026-01-07
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M0 FS 0 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-07 - 3 B
A late_start = 2026-01-06
    project_finish - - - 2026-01-08 - - .
    duration_from_late_finish - - - 2026-01-06 - 3 B
A late_finish = 2026-01-08
    project_finish - - - 2026-01-08 - - B
A total_float = 1
    early_start - - - 2026-01-05 - 1 B
    late_start - - - 2026-01-06 - - B
A free_float = 1
    total_float - - - - - 1 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
B early_start = 2026-01-07
    project_start - - - 2026-01-05 0 - .
    predecessor_ss M0 SS 2 2026-01-07 0 - B
B early_finish = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    predecessor_ss M0 SS 2 2026-01-07 0 - .
    duration_from_early_start - - - 2026-01-08 - 2 B
B late_start = 2026-01-07
    project_finish - - - 2026-01-08 - - .
    duration_from_late_finish - - - 2026-01-07 - 2 B
B late_finish = 2026-01-08
    project_finish - - - 2026-01-08 - - B
B total_float = 0
    early_start - - - 2026-01-07 - 0 B
    late_start - - - 2026-01-07 - - B
B free_float = 0
    total_float - - - - - 0 B
B scheduled_start = 2026-01-07
    early_start - - - 2026-01-07 - - B
"""

MILESTONE_CHAIN = """
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
A early_finish = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-08 - 4 B
A late_start = 2026-01-05
    project_finish - - - 2026-01-13 - - .
    successor_fs M1 FS 0 2026-01-08 0 - .
    duration_from_late_finish - - - 2026-01-05 - 4 B
A late_finish = 2026-01-08
    project_finish - - - 2026-01-13 - - .
    successor_fs M1 FS 0 2026-01-08 0 - B
A total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
A free_float = 0
    successor_free_slack M1 FS 0 2026-01-08 - 0 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M1 early_start = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 0 2026-01-08 -1 - B
M1 early_finish = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 0 2026-01-08 -1 - B
M1 late_start = 2026-01-08
    project_finish - - - 2026-01-13 - - .
    successor_fs M2 FS 0 2026-01-08 -1 - B
M1 late_finish = 2026-01-08
    project_finish - - - 2026-01-13 - - .
    successor_fs M2 FS 0 2026-01-08 -1 - B
M1 total_float = 0
    early_start - - - 2026-01-08 - 0 B
    late_start - - - 2026-01-08 - - B
M1 free_float = 0
    successor_free_slack M2 FS 0 2026-01-08 - 0 B
M1 scheduled_start = 2026-01-08
    early_start - - - 2026-01-08 - - B
M2 early_start = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M1 FS 0 2026-01-08 -1 - B
M2 early_finish = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M1 FS 0 2026-01-08 -1 - B
M2 late_start = 2026-01-08
    project_finish - - - 2026-01-13 - - .
    successor_ss B SS 0 2026-01-08 -1 - B
M2 late_finish = 2026-01-08
    project_finish - - - 2026-01-13 - - .
    successor_ss B SS 0 2026-01-08 -1 - B
M2 total_float = 0
    early_start - - - 2026-01-08 - 0 B
    late_start - - - 2026-01-08 - - B
M2 free_float = 0
    successor_free_slack B SS 0 2026-01-08 - 0 B
M2 scheduled_start = 2026-01-08
    early_start - - - 2026-01-08 - - B
B early_start = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    predecessor_ss M2 SS 0 2026-01-09 0 - B
B early_finish = 2026-01-13
    project_start - - - 2026-01-05 0 - .
    predecessor_ss M2 SS 0 2026-01-09 0 - .
    duration_from_early_start - - - 2026-01-13 - 3 B
B late_start = 2026-01-09
    project_finish - - - 2026-01-13 - - .
    duration_from_late_finish - - - 2026-01-09 - 3 B
B late_finish = 2026-01-13
    project_finish - - - 2026-01-13 - - B
B total_float = 0
    early_start - - - 2026-01-09 - 0 B
    late_start - - - 2026-01-09 - - B
B free_float = 0
    total_float - - - - - 0 B
B scheduled_start = 2026-01-09
    early_start - - - 2026-01-09 - - B
"""

TWO_PREDS = """
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
A early_finish = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-09 - 5 B
A late_start = 2026-01-05
    project_finish - - - 2026-01-13 - - .
    successor_fs M FS 0 2026-01-09 -2 - .
    duration_from_late_finish - - - 2026-01-05 - 5 B
A late_finish = 2026-01-09
    project_finish - - - 2026-01-13 - - .
    successor_fs M FS 0 2026-01-09 -2 - B
A total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
A free_float = 0
    successor_free_slack M FS 0 2026-01-09 - 0 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
C early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
C early_finish = 2026-01-07
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-07 - 3 B
C late_start = 2026-01-08
    project_finish - - - 2026-01-13 - - .
    successor_ss M SS 4 2026-01-08 0 - B
C late_finish = 2026-01-12
    project_finish - - - 2026-01-13 - - .
    successor_ss M SS 4 2026-01-08 0 - .
    duration_from_late_start M SS 4 2026-01-12 - 3 B
C total_float = 3
    early_start - - - 2026-01-05 - 3 B
    late_start - - - 2026-01-08 - - B
C free_float = 1
    successor_free_slack M SS 4 2026-01-06 - 1 B
C scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 0 2026-01-09 -1 - B
    predecessor_ss C SS 4 2026-01-09 0 - .
M early_finish = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 0 2026-01-09 -1 - B
    predecessor_ss C SS 4 2026-01-09 0 - .
M late_start = 2026-01-09
    project_finish - - - 2026-01-13 - - .
    successor_fs B FS 0 2026-01-09 -3 - B
M late_finish = 2026-01-09
    project_finish - - - 2026-01-13 - - .
    successor_fs B FS 0 2026-01-09 -3 - B
M total_float = 0
    early_start - - - 2026-01-09 - 0 B
    late_start - - - 2026-01-09 - - B
M free_float = 0
    successor_free_slack B FS 0 2026-01-09 - 0 B
M scheduled_start = 2026-01-09
    early_start - - - 2026-01-09 - - B
B early_start = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-12 2 - B
B early_finish = 2026-01-13
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-12 2 - .
    duration_from_early_start - - - 2026-01-13 - 2 B
B late_start = 2026-01-12
    project_finish - - - 2026-01-13 - - .
    duration_from_late_finish - - - 2026-01-12 - 2 B
B late_finish = 2026-01-13
    project_finish - - - 2026-01-13 - - B
B total_float = 0
    early_start - - - 2026-01-12 - 0 B
    late_start - - - 2026-01-12 - - B
B free_float = 0
    total_float - - - - - 0 B
B scheduled_start = 2026-01-12
    early_start - - - 2026-01-12 - - B
"""

FINISH_ANCHORED = """
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
A early_finish = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-09 - 5 B
A late_start = 2026-01-05
    project_finish - - - 2026-01-14 - - .
    successor_ff M FF 0 2026-01-09 0 - .
    duration_from_late_finish - - - 2026-01-05 - 5 B
A late_finish = 2026-01-09
    project_finish - - - 2026-01-14 - - .
    successor_ff M FF 0 2026-01-09 0 - B
A total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
A free_float = 0
    successor_free_slack M FF 0 2026-01-09 - 0 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
C early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
C early_finish = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-06 - 2 B
C late_start = 2026-01-09
    project_finish - - - 2026-01-14 - - .
    successor_sf M SF 1 2026-01-09 1 - B
C late_finish = 2026-01-12
    project_finish - - - 2026-01-14 - - .
    successor_sf M SF 1 2026-01-09 1 - .
    duration_from_late_start M SF 1 2026-01-12 - 2 B
C total_float = 4
    early_start - - - 2026-01-05 - 4 B
    late_start - - - 2026-01-09 - - B
C free_float = 4
    successor_free_slack M SF 1 2026-01-09 - 4 B
C scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    predecessor_ff A FF 0 2026-01-09 0 - B
    predecessor_sf C SF 1 2026-01-05 2 - .
M early_finish = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    predecessor_ff A FF 0 2026-01-09 0 - B
    predecessor_sf C SF 1 2026-01-05 2 - .
M late_start = 2026-01-09
    project_finish - - - 2026-01-14 - - .
    successor_fs B FS 0 2026-01-09 -3 - B
M late_finish = 2026-01-09
    project_finish - - - 2026-01-14 - - .
    successor_fs B FS 0 2026-01-09 -3 - B
M total_float = 0
    early_start - - - 2026-01-09 - 0 B
    late_start - - - 2026-01-09 - - B
M free_float = 0
    successor_free_slack B FS 0 2026-01-09 - 0 B
M scheduled_start = 2026-01-09
    early_start - - - 2026-01-09 - - B
B early_start = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-12 2 - B
B early_finish = 2026-01-14
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-12 2 - .
    duration_from_early_start - - - 2026-01-14 - 3 B
B late_start = 2026-01-12
    project_finish - - - 2026-01-14 - - .
    duration_from_late_finish - - - 2026-01-12 - 3 B
B late_finish = 2026-01-14
    project_finish - - - 2026-01-14 - - B
B total_float = 0
    early_start - - - 2026-01-12 - 0 B
    late_start - - - 2026-01-12 - - B
B free_float = 0
    total_float - - - - - 0 B
B scheduled_start = 2026-01-12
    early_start - - - 2026-01-12 - - B
"""

SATURDAY_MILESTONE = """
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
A early_finish = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-09 - 5 B
A late_start = 2026-01-05
    project_finish - - - 2026-01-12 - - .
    successor_fs M FS 1 2026-01-09 -2 - .
    duration_from_late_finish - - - 2026-01-05 - 5 B
A late_finish = 2026-01-09
    project_finish - - - 2026-01-12 - - .
    successor_fs M FS 1 2026-01-09 -2 - B
A total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
A free_float = 0
    successor_free_slack M FS 1 2026-01-09 - 0 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
C early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
C early_finish = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-06 - 2 B
C late_start = 2026-01-09
    project_finish - - - 2026-01-12 - - .
    successor_ff M FF 0 2026-01-12 0 - .
    duration_from_late_finish - - - 2026-01-09 - 2 B
C late_finish = 2026-01-12
    project_finish - - - 2026-01-12 - - .
    successor_ff M FF 0 2026-01-12 0 - B
C total_float = 4
    early_start - - - 2026-01-05 - 4 B
    late_start - - - 2026-01-09 - - B
C free_float = 3
    successor_free_slack M FF 0 2026-01-09 - 3 B
C scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-10
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 1 2026-01-10 -1 - B
    predecessor_ff C FF 0 2026-01-06 0 - .
M early_finish = 2026-01-10
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 1 2026-01-10 -1 - B
    predecessor_ff C FF 0 2026-01-06 0 - .
M late_start = 2026-01-12
    project_finish - - - 2026-01-12 - - .
    successor_ff B FF 0 2026-01-12 0 - B
M late_finish = 2026-01-12
    project_finish - - - 2026-01-12 - - .
    successor_ff B FF 0 2026-01-12 0 - B
M total_float = 1
    early_start - - - 2026-01-10 - 1 B
    late_start - - - 2026-01-12 - - B
M free_float = 1
    successor_free_slack B FF 0 2026-01-12 - 1 B
M scheduled_start = 2026-01-10
    early_start - - - 2026-01-10 - - B
B early_start = 2026-01-09
    project_start - - - 2026-01-05 0 - .
    predecessor_ff M FF 0 2026-01-12 2 - .
    early_finish_pullback M FF 0 2026-01-09 - - B
B early_finish = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    predecessor_ff M FF 0 2026-01-12 2 - B
B late_start = 2026-01-09
    project_finish - - - 2026-01-12 - - .
    duration_from_late_finish - - - 2026-01-09 - 2 B
B late_finish = 2026-01-12
    project_finish - - - 2026-01-12 - - B
B total_float = 0
    early_start - - - 2026-01-09 - 0 B
    late_start - - - 2026-01-09 - - B
B free_float = 0
    total_float - - - - - 0 B
B scheduled_start = 2026-01-09
    early_start - - - 2026-01-09 - - B
"""

MILESTONE_WITH_FLOAT = """
L early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
L early_finish = 2026-01-16
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-16 - 10 B
L late_start = 2026-01-05
    project_finish - - - 2026-01-16 - - .
    duration_from_late_finish - - - 2026-01-05 - 10 B
L late_finish = 2026-01-16
    project_finish - - - 2026-01-16 - - B
L total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
L free_float = 0
    total_float - - - - - 0 B
L scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
A early_finish = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-06 - 2 B
A late_start = 2026-01-13
    project_finish - - - 2026-01-16 - - .
    successor_fs M FS 0 2026-01-14 0 - .
    duration_from_late_finish - - - 2026-01-13 - 2 B
A late_finish = 2026-01-14
    project_finish - - - 2026-01-16 - - .
    successor_fs M FS 0 2026-01-14 0 - B
A total_float = 6
    early_start - - - 2026-01-05 - 6 B
    late_start - - - 2026-01-13 - - B
A free_float = 0
    successor_free_slack M FS 0 2026-01-06 - 0 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 0 2026-01-06 -1 - B
M early_finish = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    predecessor_fs A FS 0 2026-01-06 -1 - B
M late_start = 2026-01-14
    project_finish - - - 2026-01-16 - - .
    successor_fs B FS 0 2026-01-14 -1 - B
M late_finish = 2026-01-14
    project_finish - - - 2026-01-16 - - .
    successor_fs B FS 0 2026-01-14 -1 - B
M total_float = 7
    early_start - - - 2026-01-06 - 7 B
    late_start - - - 2026-01-14 - - B
M free_float = 0
    successor_free_slack B FS 0 2026-01-06 - 0 B
M scheduled_start = 2026-01-06
    early_start - - - 2026-01-06 - - B
B early_start = 2026-01-07
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-07 0 - B
B early_finish = 2026-01-08
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-07 0 - .
    duration_from_early_start - - - 2026-01-08 - 2 B
B late_start = 2026-01-15
    project_finish - - - 2026-01-16 - - .
    duration_from_late_finish - - - 2026-01-15 - 2 B
B late_finish = 2026-01-16
    project_finish - - - 2026-01-16 - - B
B total_float = 6
    early_start - - - 2026-01-07 - 6 B
    late_start - - - 2026-01-15 - - B
B free_float = 6
    total_float - - - - - 6 B
B scheduled_start = 2026-01-07
    early_start - - - 2026-01-07 - - B
"""

MILESTONE_FLOORS = """
X early_start = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - B
X early_finish = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - .
    duration_from_early_start - - - 2026-01-06 - 1 B
X late_start = 2026-01-12
    project_finish - - - 2026-01-15 - - .
    successor_fs M FS 0 2026-01-12 0 - .
    duration_from_late_finish - - - 2026-01-12 - 1 B
X late_finish = 2026-01-12
    project_finish - - - 2026-01-15 - - .
    successor_fs M FS 0 2026-01-12 0 - B
X total_float = 4
    early_start - - - 2026-01-06 - 4 B
    late_start - - - 2026-01-12 - - B
X free_float = 3
    successor_free_slack M FS 0 2026-01-09 - 3 B
X scheduled_start = 2026-01-06
    early_start - - - 2026-01-06 - - B
L early_start = 2026-01-06
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - B
L early_finish = 2026-01-15
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - .
    duration_from_early_start - - - 2026-01-15 - 8 B
L late_start = 2026-01-06
    project_finish - - - 2026-01-15 - - .
    duration_from_late_finish - - - 2026-01-06 - 8 B
L late_finish = 2026-01-15
    project_finish - - - 2026-01-15 - - B
L total_float = 0
    early_start - - - 2026-01-06 - 0 B
    late_start - - - 2026-01-06 - - B
L free_float = 0
    total_float - - - - - 0 B
L scheduled_start = 2026-01-06
    early_start - - - 2026-01-06 - - B
M early_start = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - .
    planned_start_snet - - - 2026-01-12 2 - B
    predecessor_fs X FS 0 2026-01-06 -1 - .
M early_finish = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - .
    planned_start_snet - - - 2026-01-12 2 - B
    predecessor_fs X FS 0 2026-01-06 -1 - .
M late_start = 2026-01-13
    project_finish - - - 2026-01-15 - - .
    successor_ss Z SS 1 2026-01-13 0 - B
M late_finish = 2026-01-13
    project_finish - - - 2026-01-15 - - .
    successor_ss Z SS 1 2026-01-13 0 - B
M total_float = 1
    early_start - - - 2026-01-12 - 1 B
    late_start - - - 2026-01-13 - - B
M free_float = 0
    successor_free_slack Z SS 1 2026-01-12 - 0 B
M scheduled_start = 2026-01-12
    early_start - - - 2026-01-12 - - B
Z early_start = 2026-01-13
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - .
    predecessor_ss M SS 1 2026-01-13 0 - B
Z early_finish = 2026-01-14
    project_start - - - 2026-01-05 0 - .
    data_date - - - 2026-01-06 0 - .
    predecessor_ss M SS 1 2026-01-13 0 - .
    duration_from_early_start - - - 2026-01-14 - 2 B
Z late_start = 2026-01-14
    project_finish - - - 2026-01-15 - - .
    duration_from_late_finish - - - 2026-01-14 - 2 B
Z late_finish = 2026-01-15
    project_finish - - - 2026-01-15 - - B
Z total_float = 1
    early_start - - - 2026-01-13 - 1 B
    late_start - - - 2026-01-14 - - B
Z free_float = 1
    total_float - - - - - 1 B
Z scheduled_start = 2026-01-13
    early_start - - - 2026-01-13 - - B
"""

MILESTONE_ON_A_SATURDAY_ACTUAL = """
L early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
L early_finish = 2026-01-14
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-14 - 8 B
L late_start = 2026-01-05
    project_finish - - - 2026-01-14 - - .
    duration_from_late_finish - - - 2026-01-05 - 8 B
L late_finish = 2026-01-14
    project_finish - - - 2026-01-14 - - B
L total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
L free_float = 0
    total_float - - - - - 0 B
L scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-10
    project_start - - - 2026-01-05 0 - .
    actual_start - - - 2026-01-10 - - B
M early_finish = 2026-01-10
    project_start - - - 2026-01-05 0 - .
    actual_start - - - 2026-01-10 - - .
    duration_from_early_start - - - 2026-01-10 - 0 B
M late_start = 2026-01-13
    project_finish - - - 2026-01-14 - - .
    successor_fs Z FS 0 2026-01-13 0 - B
M late_finish = 2026-01-13
    project_finish - - - 2026-01-14 - - .
    successor_fs Z FS 0 2026-01-13 0 - B
M total_float = 1
    early_start - - - 2026-01-10 - 1 B
    late_start - - - 2026-01-13 - - B
M free_float = 0
    successor_free_slack Z FS 0 2026-01-10 - 0 B
M scheduled_start = 2026-01-10
    early_start - - - 2026-01-10 - - B
Z early_start = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-12 2 - B
Z early_finish = 2026-01-13
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-12 2 - .
    duration_from_early_start - - - 2026-01-13 - 2 B
Z late_start = 2026-01-13
    project_finish - - - 2026-01-14 - - .
    duration_from_late_finish - - - 2026-01-13 - 2 B
Z late_finish = 2026-01-14
    project_finish - - - 2026-01-14 - - B
Z total_float = 1
    early_start - - - 2026-01-12 - 1 B
    late_start - - - 2026-01-13 - - B
Z free_float = 1
    total_float - - - - - 1 B
Z scheduled_start = 2026-01-12
    early_start - - - 2026-01-12 - - B
"""

TERMINAL_MILESTONE = """
L early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
L early_finish = 2026-01-07
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-07 - 3 B
L late_start = 2026-01-07
    project_finish - - - 2026-01-09 - - .
    successor_fs M FS 0 2026-01-09 -2 - .
    duration_from_late_finish - - - 2026-01-07 - 3 B
L late_finish = 2026-01-09
    project_finish - - - 2026-01-09 - - .
    successor_fs M FS 0 2026-01-09 -2 - B
L total_float = 2
    early_start - - - 2026-01-05 - 2 B
    late_start - - - 2026-01-07 - - B
L free_float = 2
    successor_free_slack M FS 0 2026-01-09 - 2 B
L scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    planned_start_snet - - - 2026-01-12 0 - B
    predecessor_fs L FS 0 2026-01-07 -1 - .
M early_finish = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    planned_start_snet - - - 2026-01-12 0 - B
    predecessor_fs L FS 0 2026-01-07 -1 - .
M late_start = 2026-01-12
    project_finish - - - 2026-01-12 - - B
M late_finish = 2026-01-12
    project_finish - - - 2026-01-12 - - B
M total_float = 0
    early_start - - - 2026-01-12 - 0 B
    late_start - - - 2026-01-12 - - B
M free_float = 0
    total_float - - - - - 0 B
M scheduled_start = 2026-01-12
    early_start - - - 2026-01-12 - - B
"""

INSTANT_BEATS_DISPLAY = """
A early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
A early_finish = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-12 - 6 B
A late_start = 2026-01-05
    project_finish - - - 2026-01-14 - - .
    successor_fs M FS 0 2026-01-12 0 - .
    duration_from_late_finish - - - 2026-01-05 - 6 B
A late_finish = 2026-01-12
    project_finish - - - 2026-01-14 - - .
    successor_fs M FS 0 2026-01-12 0 - B
A total_float = 0
    early_start - - - 2026-01-05 - 0 B
    late_start - - - 2026-01-05 - - B
A free_float = 0
    successor_free_slack M FS 0 2026-01-12 - 0 B
A scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
C early_start = 2026-01-05
    project_start - - - 2026-01-05 0 - B
C early_finish = 2026-01-05
    project_start - - - 2026-01-05 0 - .
    duration_from_early_start - - - 2026-01-05 - 1 B
C late_start = 2026-01-06
    project_finish - - - 2026-01-14 - - .
    successor_ss M SS 7 2026-01-06 0 - B
C late_finish = 2026-01-06
    project_finish - - - 2026-01-14 - - .
    successor_ss M SS 7 2026-01-06 0 - .
    duration_from_late_start M SS 7 2026-01-06 - 1 B
C total_float = 1
    early_start - - - 2026-01-05 - 1 B
    late_start - - - 2026-01-06 - - B
C free_float = 1
    successor_free_slack M SS 7 2026-01-06 - 1 B
C scheduled_start = 2026-01-05
    early_start - - - 2026-01-05 - - B
M early_start = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    predecessor_ss C SS 7 2026-01-12 0 - .
    predecessor_fs A FS 0 2026-01-12 -1 - B
M early_finish = 2026-01-12
    project_start - - - 2026-01-05 0 - .
    predecessor_ss C SS 7 2026-01-12 0 - .
    predecessor_fs A FS 0 2026-01-12 -1 - B
M late_start = 2026-01-12
    project_finish - - - 2026-01-14 - - .
    successor_fs B FS 0 2026-01-12 -1 - B
M late_finish = 2026-01-12
    project_finish - - - 2026-01-14 - - .
    successor_fs B FS 0 2026-01-12 -1 - B
M total_float = 0
    early_start - - - 2026-01-12 - 0 B
    late_start - - - 2026-01-12 - - B
M free_float = 0
    successor_free_slack B FS 0 2026-01-12 - 0 B
M scheduled_start = 2026-01-12
    early_start - - - 2026-01-12 - - B
B early_start = 2026-01-13
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-13 0 - B
B early_finish = 2026-01-14
    project_start - - - 2026-01-05 0 - .
    predecessor_fs M FS 0 2026-01-13 0 - .
    duration_from_early_start - - - 2026-01-14 - 2 B
B late_start = 2026-01-13
    project_finish - - - 2026-01-14 - - .
    duration_from_late_finish - - - 2026-01-13 - 2 B
B late_finish = 2026-01-14
    project_finish - - - 2026-01-14 - - B
B total_float = 0
    early_start - - - 2026-01-13 - 0 B
    late_start - - - 2026-01-13 - - B
B free_float = 0
    total_float - - - - - 0 B
B scheduled_start = 2026-01-13
    early_start - - - 2026-01-13 - - B
"""

GOLDEN: dict[str, str] = {
    "start_milestone": START_MILESTONE,
    "milestone_chain": MILESTONE_CHAIN,
    "two_preds": TWO_PREDS,
    "finish_anchored": FINISH_ANCHORED,
    "saturday_milestone": SATURDAY_MILESTONE,
    "milestone_with_float": MILESTONE_WITH_FLOAT,
    "milestone_floors": MILESTONE_FLOORS,
    "milestone_on_a_saturday_actual": MILESTONE_ON_A_SATURDAY_ACTUAL,
    "terminal_milestone": TERMINAL_MILESTONE,
    "instant_beats_display": INSTANT_BEATS_DISPLAY,
}


@pytest.mark.parametrize("network", sorted(GOLDEN))
def test_every_golden_value_is_the_engines(network: str) -> None:
    """The oracle behind the tables: each derived value is read off the result.

    Without this the golden tables would be a snapshot of themselves — they would
    keep agreeing with whatever ``derive.py`` last produced. Here the expected
    value comes from the scheduled :class:`Task`, so a table row can only stand if
    the engine reports that same number or date.
    """
    project = _networks()[network]
    result = schedule(project)
    by_id = {t.id: t for t in result.tasks}
    expected = _parse(GOLDEN[network])
    assert expected, "the golden table must not be empty"
    for (task_id, quantity), (value, _) in expected.items():
        task = by_id[task_id]
        attribute = getattr(task, quantity)
        engine_value = attribute.days if isinstance(attribute, timedelta) else attribute.isoformat()
        assert str(engine_value) == value, f"{network}/{task_id}/{quantity}"
        assert str(derive_value(project, task_id, quantity, result).value) == value


@pytest.mark.parametrize("network", sorted(GOLDEN))
def test_milestone_derivation_contributions_are_exact(network: str) -> None:
    """Every candidate term, in order, with the binding one marked.

    A mutant that keeps the right *date* but names the wrong constraint — the
    project-start floor instead of the driving predecessor, the successor's late
    dates instead of a milestone successor's instant references, the node's own
    calendar instead of the predecessor's — produces an explanation that is
    exactly as wrong as no explanation, and is invisible to any assertion that
    only compares the binding term's date with the value (ADR-0218).
    """
    project = _networks()[network]
    result = schedule(project)
    for (task_id, quantity), (_, terms) in _parse(GOLDEN[network]).items():
        derivation = derive_value(project, task_id, quantity, result)
        assert _render(derivation) == terms, f"{network}/{task_id}/{quantity}"


@pytest.mark.parametrize("network", sorted(GOLDEN))
def test_exactly_one_term_binds_each_date_quantity(network: str) -> None:
    """One binding, and it is the term reported as ``Derivation.binding``.

    ``total_float`` is the documented exception: it marks both ends of the span it
    measures, so the invariant is stated over the date quantities and free float.
    """
    project = _networks()[network]
    result = schedule(project)
    for task in result.tasks:
        for quantity in Quantity:
            if quantity is Quantity.TOTAL_FLOAT:
                continue
            derivation = derive_value(project, task.id, quantity, result)
            bindings = [c for c in derivation.contributions if c.is_binding]
            assert len(bindings) == 1, f"{network}/{task.id}/{quantity.value}"
            assert derivation.binding is bindings[0]
            if quantity is Quantity.FREE_FLOAT:
                assert bindings[0].slack_days == derivation.value
            else:
                assert bindings[0].imposed_date is not None
                assert bindings[0].imposed_date.isoformat() == derivation.value


def test_total_float_of_a_milestone_on_a_non_working_day_cites_both_ends() -> None:
    """``M`` is pinned to a Saturday actual, so its instant sits on a non-working day.

    Total float is a span, so the derivation marks *both* ends binding — that is
    the one quantity where ``Derivation.binding`` is not the whole story, and the
    pair has to be the milestone's own early and late positions rather than a
    neighbouring task's.

    Note on what this does not pin: the engine measures a milestone's float
    between its instants and this test cannot tell that apart from measuring it
    between the displayed days. On the calendars reachable here the two spans are
    shifted by the same amount and ``_working_days_between`` returns the same
    count for both, so the instant pair is not observable through ``derive_value``
    — do not add an assertion claiming otherwise (it would pass either way).
    """
    project = _networks()["milestone_on_a_saturday_actual"]
    result = schedule(project)
    milestone = next(t for t in result.tasks if t.id == "M")
    assert milestone.early_start == date(2026, 1, 10)  # a Saturday
    assert not project.calendar.is_working_day(milestone.early_start)
    assert milestone.total_float == timedelta(days=1)

    derivation = derive_value(project, "M", Quantity.TOTAL_FLOAT, result)
    assert derivation.value == 1
    span = [c for c in derivation.contributions if c.is_binding]
    assert [c.kind for c in span] == ["early_start", "late_start"]
    assert [c.imposed_date for c in span] == [date(2026, 1, 10), date(2026, 1, 13)]
    assert [c.source_task_id for c in span] == [None, None]


def test_a_finish_anchored_bound_out_of_a_milestone_uses_the_milestones_calendar() -> None:
    """The predecessor's calendar, not the successor's (#4079).

    ``M`` is a milestone on a six-day calendar and its instant falls on a Sunday,
    so the last working moment before it is the Saturday. ``B`` runs on the
    default five-day calendar: reading the FF anchor on *B's* calendar would find
    the Friday instead and hand ``B`` a two-day head start it does not have.
    """
    project = _networks()["saturday_milestone"]
    result = schedule(project)
    milestone = next(t for t in result.tasks if t.id == "M")
    assert milestone.early_finish == date(2026, 1, 10)  # the Saturday
    assert SAT_CAL.is_working_day(milestone.early_finish)
    assert not project.calendar.is_working_day(milestone.early_finish)

    derivation = derive_value(project, "B", Quantity.EARLY_FINISH, result)
    assert derivation.binding is not None
    assert derivation.binding.kind == "predecessor_ff"
    assert derivation.binding.source_task_id == "M"
    assert derivation.binding.imposed_date == date(2026, 1, 12)
    # Saturday -> Monday is the two-day snap on B's own calendar; anchoring on the
    # Friday instead would make this 0 and move the date back to 2026-01-09.
    assert derivation.binding.calendar_days_added == 2


def test_a_milestone_instant_is_the_anchor_for_its_own_successors() -> None:
    """A milestone predecessor anchors on its instant, not on ``early_finish + 1``.

    ``M0`` sits at the start of the project's first working day, so its instant is
    that midnight and ``A`` may start the same day. Reading ``early_finish + 1``
    instead — the ordinary-work FS anchor — pushes ``A`` to the next day, which is
    the extra working day per milestone that #4079 removed.
    """
    project = _networks()["start_milestone"]
    result = schedule(project)
    derivation = derive_value(project, "A", Quantity.EARLY_START, result)
    assert derivation.binding is not None
    assert derivation.binding.kind == "predecessor_fs"
    assert derivation.binding.source_task_id == "M0"
    assert derivation.binding.imposed_date == MON
    assert [c.kind for c in derivation.contributions] == ["project_start", "predecessor_fs"]


def test_a_milestone_instant_set_by_a_floor_cites_the_floor() -> None:
    """No link proposes ``M0``'s instant, so the project-start floor binds it.

    The milestone branch of the forward derivation picks the term proposing the
    latest instant and prefers a real link on a tie; with no incoming link at all
    the floor must still be selected rather than falling off the end of that scan.
    """
    project = _networks()["start_milestone"]
    result = schedule(project)
    for quantity in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        derivation = derive_value(project, "M0", quantity, result)
        assert derivation.binding is not None
        assert derivation.binding.source_task_id is None
        assert derivation.value == MON.isoformat()


def test_a_terminal_milestone_is_bounded_by_the_projects_finish_instant() -> None:
    """No successor bounds ``M``, so the project-finish seed is the only late term.

    The seed is the finish *instant* — here the start of 2026-01-12, the day ``M``
    itself ends the project on — not the end of that day. Seeding from
    ``project_finish + 1`` would hand ``M`` a day of float it does not have, and
    the scan for a driving link has nothing to fall back on but this anchor.
    """
    project = _networks()["terminal_milestone"]
    result = schedule(project)
    milestone = next(t for t in result.tasks if t.id == "M")
    assert milestone.total_float == timedelta(days=0)
    for quantity in (Quantity.LATE_START, Quantity.LATE_FINISH):
        derivation = derive_value(project, "M", quantity, result)
        assert [c.kind for c in derivation.contributions] == ["project_finish"]
        assert derivation.binding is not None
        assert derivation.binding.source_task_id is None
        assert derivation.binding.imposed_date == date(2026, 1, 12)


def test_the_later_instant_wins_even_when_both_terms_show_the_same_day() -> None:
    """``C``'s SS term and ``A``'s FS term both display 2026-01-12.

    As instants they differ: SS proposes the midnight starting the Monday, FS the
    midnight ending it. ``A`` therefore binds. ``C``'s dependency is declared
    first, so a derivation that compares displayed dates — or that loses the
    instant keys altogether — reports ``C``, silently naming the wrong driver on a
    date that still checks out.
    """
    project = _networks()["instant_beats_display"]
    result = schedule(project)
    for quantity in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        derivation = derive_value(project, "M", quantity, result)
        terms = {c.source_task_id: c for c in derivation.contributions if c.source_task_id}
        assert terms["C"].imposed_date == terms["A"].imposed_date == date(2026, 1, 12)
        assert [c.source_task_id for c in derivation.contributions] == [None, "C", "A"]
        assert derivation.binding is terms["A"]


def test_competing_links_into_one_instant_are_resolved_on_the_instant_not_the_day() -> None:
    """``A``'s FS and ``C``'s SS both propose 2026-01-09 as the displayed day.

    They are not equal as instants: the FS link proposes the midnight ending the
    Friday and the SS link proposes the midnight starting it, so the FS term is
    later and binds. Comparing the displayed dates makes them a tie, which would
    hand the explanation to whichever term happens to come first.
    """
    project = _networks()["two_preds"]
    result = schedule(project)
    for quantity in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        derivation = derive_value(project, "M", quantity, result)
        terms = {c.source_task_id: c for c in derivation.contributions if c.source_task_id}
        assert terms["A"].imposed_date == terms["C"].imposed_date == date(2026, 1, 9)
        assert terms["A"].is_binding
        assert not terms["C"].is_binding
        assert derivation.binding is terms["A"]
