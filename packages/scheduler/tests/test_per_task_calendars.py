"""Per-task calendars (ADR-0120 D3) — the substrate for the program-scoped CPM pass.

A task may opt into its own working week via ``Task.calendar_id`` + a
``Project.calendars`` registry. Duration arithmetic uses the task's own calendar;
lag on an edge is consumed on the *successor's* calendar. The whole feature is
additive: a project with no ``calendars`` registry schedules byte-for-byte as it
did before, which the broader suite already proves — these tests pin the *new*
behavior and the convention's edges.

All scenarios anchor on Mon 2026-01-05 (so Sat 2026-01-10 / Sun 2026-01-11 are the
first weekend) and use two calendars: the default Mon-Fri week, and an all-seven-day
week registered as ``"seven"``.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler.engine import InvalidScheduleInput, schedule
from trueppm_scheduler.models import Calendar, Dependency, DependencyType, Project, Task

MON = date(2026, 1, 5)  # Monday — project anchor for every scenario
SEVEN = Calendar(working_days=0b111_1111)  # every weekday is a working day


def _task(tid: str, days: int, calendar_id: str | None = None, **kw: object) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days), calendar_id=calendar_id, **kw)


def _result(project: Project) -> dict[str, Task]:
    return {t.id: t for t in schedule(project).tasks}


def _cpm_fields(project: Project) -> dict[str, object]:
    """Project the schedule down to its *computed* fields only.

    Two projects can schedule to identical dates while differing on an input field
    like ``calendar_id``; comparing the full ``to_dict`` would flag that input
    difference. This keeps only the CPM outputs that must match.
    """
    res = schedule(project)
    return {
        "project_start": res.project_start,
        "project_finish": res.project_finish,
        "critical_path": res.critical_path,
        "tasks": {
            t.id: (
                t.early_start,
                t.early_finish,
                t.late_start,
                t.late_finish,
                t.total_float,
                t.free_float,
                t.is_critical,
            )
            for t in res.tasks
        },
    }


# ---------------------------------------------------------------------------
# Backward compatibility — the fast path must stay identical
# ---------------------------------------------------------------------------


def test_calendars_none_is_unchanged() -> None:
    """A project that declares no per-task calendars schedules exactly as before."""
    tasks = [_task("a", 6), _task("b", 3)]
    deps = [Dependency("a", "b")]
    base = schedule(Project(id="p", name="p", start_date=MON, tasks=tasks, dependencies=deps))
    # Explicit None registry — the resolver returns None and the fast path runs.
    withfield = schedule(
        Project(
            id="p",
            name="p",
            start_date=MON,
            tasks=[_task("a", 6), _task("b", 3)],
            dependencies=[Dependency("a", "b")],
            calendars=None,
        )
    )
    assert base.to_dict() == withfield.to_dict()


def test_registry_calendar_equal_to_default_matches_fast_path() -> None:
    """Opting every task into a calendar *equal to* the default reproduces the fast path.

    This is the strongest single check that the per-task code path computes the
    same numbers as the single-calendar path when the calendars happen to match —
    duration, lag snapping, and float all included, across all four dep types.
    """

    def build(*, use_registry: bool) -> Project:
        tasks = [
            _task("a", 5, "wk" if use_registry else None),
            _task("b", 3, "wk" if use_registry else None),
            _task("c", 4, "wk" if use_registry else None),
            _task("d", 2, "wk" if use_registry else None),
        ]
        deps = [
            Dependency("a", "b", DependencyType.FS, timedelta(days=2)),
            Dependency("a", "c", DependencyType.SS),
            Dependency("b", "d", DependencyType.FF, timedelta(days=1)),
            Dependency("c", "d", DependencyType.SF),
        ]
        return Project(
            id="p",
            name="p",
            start_date=MON,
            tasks=tasks,
            dependencies=deps,
            calendars={"wk": Calendar()} if use_registry else None,
        )

    assert _cpm_fields(build(use_registry=True)) == _cpm_fields(build(use_registry=False))


# ---------------------------------------------------------------------------
# Duration arithmetic uses the task's own calendar
# ---------------------------------------------------------------------------


def test_duration_spans_own_calendar() -> None:
    """A 6-day task on the 7-day week finishes before the same task on Mon-Fri.

    6 working days from Mon 01-05: Mon-Fri uses 01-05..01-09 then skips the weekend
    to finish 01-12; the 7-day week uses 01-05..01-10 and finishes on Sat 01-10.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("five", 6), _task("seven", 6, "seven")],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["five"].early_finish == date(2026, 1, 12)  # Mon-Fri skips the weekend
    assert r["seven"].early_finish == date(2026, 1, 10)  # Sat is a working day here


def test_unknown_calendar_id_falls_back_to_default() -> None:
    """A calendar_id naming no registry entry uses the pass-level calendar (no error)."""
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("ghost", 6, "does-not-exist")],
        calendars={"seven": SEVEN},
    )
    # Mon-Fri behavior (the default), not the 7-day one.
    assert _result(project)["ghost"].early_finish == date(2026, 1, 12)


# ---------------------------------------------------------------------------
# Cross-calendar FS handoff + lag-on-successor convention
# ---------------------------------------------------------------------------


def test_fs_successor_starts_on_its_own_calendar() -> None:
    """An FS successor on the 7-day week may start on a Saturday its predecessor can't.

    Pred (Mon-Fri) finishes Fri 01-09; the successor on the 7-day week starts the
    very next day, Sat 01-10 — proving the start snap uses the *successor's* week.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("pred", 5), _task("succ", 3, "seven")],
        dependencies=[Dependency("pred", "succ")],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["pred"].early_finish == date(2026, 1, 9)  # Fri
    assert r["succ"].early_start == date(2026, 1, 10)  # Sat — successor's calendar


def test_lag_is_counted_on_successor_calendar() -> None:
    """FS lag snaps on the successor's calendar, not the predecessor's.

    Pred on the 7-day week finishes Fri 01-09. With +1 day past finish and +1 day
    lag the raw date is Sun 01-11; the Mon-Fri successor snaps it forward to Mon
    01-12. If the snap used the predecessor's 7-day week it would land on Sun 01-11.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("pred", 5, "seven"), _task("succ", 2)],
        dependencies=[Dependency("pred", "succ", DependencyType.FS, timedelta(days=1))],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["pred"].early_finish == date(2026, 1, 9)  # Fri (7-day week)
    assert r["succ"].early_start == date(2026, 1, 12)  # Mon — successor's Mon-Fri snap


# ---------------------------------------------------------------------------
# Criticality stays program-true across a calendar boundary
# ---------------------------------------------------------------------------


def test_cross_calendar_chain_is_critical() -> None:
    """A single FS chain across two calendars carries zero total float end-to-end.

    The whole point of ADR-0120: the cross-calendar critical path is honest. A
    lone chain has no slack anywhere, so every task must be critical regardless of
    which calendar it sits on.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4), _task("b", 3, "seven"), _task("c", 2)],
        dependencies=[Dependency("a", "b"), Dependency("b", "c")],
        calendars={"seven": SEVEN},
    )
    result = schedule(project)
    r = {t.id: t for t in result.tasks}
    assert r["a"].is_critical and r["b"].is_critical and r["c"].is_critical
    assert result.critical_path == ["a", "b", "c"]
    for t in result.tasks:
        assert t.total_float >= timedelta(0)
        assert t.free_float >= timedelta(0)


def test_slack_task_off_critical_path_has_float() -> None:
    """A short parallel branch on a different calendar reports positive total float."""
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("start", 1), _task("long", 10), _task("short", 2, "seven"), _task("end", 1)],
        dependencies=[
            Dependency("start", "long"),
            Dependency("start", "short"),
            Dependency("long", "end"),
            Dependency("short", "end"),
        ],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["long"].is_critical
    assert not r["short"].is_critical
    assert r["short"].total_float > timedelta(0)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_registry_calendar_with_empty_mask_is_rejected() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 2, "broken")],
        calendars={"broken": Calendar(working_days=0)},
    )
    with pytest.raises(InvalidScheduleInput, match="broken"):
        schedule(project)


def test_non_string_calendar_id_is_rejected() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 2, 123)],  # type: ignore[arg-type]
        calendars={"seven": SEVEN},
    )
    with pytest.raises(InvalidScheduleInput, match="calendar_id"):
        schedule(project)


# ---------------------------------------------------------------------------
# Serialization round-trip
# ---------------------------------------------------------------------------


def test_round_trip_preserves_per_task_calendars() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4), _task("b", 3, "seven")],
        dependencies=[Dependency("a", "b")],
        calendars={"seven": SEVEN},
    )
    restored = Project.from_dict(project.to_dict())
    assert restored.calendars is not None
    assert restored.calendars["seven"].working_days == 0b111_1111
    assert restored.tasks[1].calendar_id == "seven"
    # The restored project schedules to the same dates as the original.
    assert schedule(restored).to_dict() == schedule(project).to_dict()


def test_json_round_trip_with_calendars() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4, "seven")],
        calendars={"seven": SEVEN},
    )
    restored = Project.from_json(project.to_json())
    assert restored.calendars is not None and "seven" in restored.calendars
    assert restored.tasks[0].calendar_id == "seven"


def test_to_dict_omits_calendars_when_absent() -> None:
    """The serialized form carries an explicit null when no registry is set."""
    project = Project(id="p", name="p", start_date=MON, tasks=[_task("a", 2)])
    assert project.to_dict()["calendars"] is None
