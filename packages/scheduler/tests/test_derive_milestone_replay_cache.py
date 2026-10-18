"""derive_value reads schedule()'s milestone pass state instead of replaying it (#4524).

Explaining any value on a project with a zero-duration task needs each milestone's
instants, which the :class:`ScheduleResult` does not carry. ``derive_value`` used
to recover them with a full forward + backward replay (``_milestone_instants``)
plus a graph rebuild (``_project_free_instants``) on every call — ~140x the cost
of a milestone-free derivation at 10k tasks, and nearly every real project has a
milestone. :func:`schedule` now attaches the exact maps it computed to the result
it returns, and ``derive_value`` reads them when the result is that project's.

The oracle is equivalence with the replay, which stays as the fallback for a
result ``schedule()`` did not produce for the same project object.
``dataclasses.replace(result)`` drops the private attribute, so it forces the
replay path on an otherwise identical result: every test below compares the two
paths, never a hand-written date.
"""

from __future__ import annotations

import dataclasses
import itertools
import random
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Quantity,
    SchedulerError,
    Task,
    derive_value,
    engine,
    schedule,
)
from trueppm_scheduler.engine import ScheduleResult

MON = date(2026, 1, 5)
SAT_CAL = Calendar(working_days=0b0111111)  # Mon-Sat
QUANTITIES = list(Quantity)


def _derive_or_error(project: Project, tid: str, q: Quantity, result: ScheduleResult) -> object:
    try:
        return derive_value(project, tid, q, result)
    except SchedulerError as err:  # compare refusals too, not just values
        return (type(err), str(err))


def _assert_equivalent(project: Project) -> None:
    """Every (task, quantity) derives identically from the kept state and the replay."""
    result = schedule(project)
    if not any(t.duration.days == 0 for t in project.tasks):
        return
    assert isinstance(getattr(result, engine._MILESTONE_REPLAY_ATTR, None), engine._MilestoneReplay)
    replayed = dataclasses.replace(result)
    assert getattr(replayed, engine._MILESTONE_REPLAY_ATTR, None) is None

    # The maps themselves, including any derive_value does not happen to read.
    assert engine._milestone_replay(project, result) == engine._milestone_replay(project, replayed)
    for task in project.tasks:
        for q in QUANTITIES:
            kept = _derive_or_error(project, task.id, q, result)
            ref = _derive_or_error(project, task.id, q, replayed)
            assert kept == ref, (task.id, q)


def _task(tid: str, days: int, **kwargs: object) -> Task:
    t = Task(id=tid, name=tid, duration=timedelta(days=days))
    for key, value in kwargs.items():
        setattr(t, key, value)
    return t


_PRED_STATES: dict[str, dict[str, object]] = {
    "live": {},
    "in_progress": {"actual_start": MON, "percent_complete": 40.0},
    "done_no_actuals": {"percent_complete": 100.0},
    "done_actuals": {
        "actual_start": MON,
        "actual_finish": MON + timedelta(days=3),
        "percent_complete": 100.0,
    },
}
_MS_STATES: dict[str, dict[str, object]] = {
    "live": {},
    "closed_no_actuals": {"percent_complete": 100.0},
    "closed_actuals": {"actual_finish": MON + timedelta(days=4), "percent_complete": 100.0},
}


def _grid_project(
    dep_type: DependencyType, lag: int, pred_state: str, ms_state: str, per_task_cal: bool
) -> Project:
    """A -[dep_type, lag]-> M -FS-> B -SS+1-> M2, plus an unlinked terminal milestone T."""
    cal_kw: dict[str, object] = {"calendar_id": "sat"} if per_task_cal else {}
    tasks = [
        _task("A", 3, **_PRED_STATES[pred_state]),
        _task("M", 0, **_MS_STATES[ms_state], **cal_kw),
        _task("B", 2, **cal_kw),
        _task("M2", 0),
        _task("T", 0),
        _task("C", 4),
    ]
    deps = [
        Dependency("A", "M", dep_type, timedelta(days=lag)),
        Dependency("M", "B", DependencyType.FS, timedelta(0)),
        Dependency("B", "M2", DependencyType.SS, timedelta(days=1)),
        Dependency("A", "C", DependencyType.FS, timedelta(0)),
    ]
    return Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=tasks,
        dependencies=deps,
        status_date=MON + timedelta(days=2),
        calendars={"sat": SAT_CAL} if per_task_cal else None,
    )


@pytest.mark.parametrize(
    ("dep_type", "lag", "pred_state", "ms_state", "per_task_cal"),
    list(
        itertools.product(
            list(DependencyType), [0, 1, 2], list(_PRED_STATES), list(_MS_STATES), [False, True]
        )
    ),
)
def test_kept_state_matches_replay_across_the_grid(
    dep_type: DependencyType, lag: int, pred_state: str, ms_state: str, per_task_cal: bool
) -> None:
    _assert_equivalent(_grid_project(dep_type, lag, pred_state, ms_state, per_task_cal))


def _random_project(rng: random.Random, n: int) -> Project:
    tasks: list[Task] = []
    for i in range(n):
        days = 0 if rng.random() < 0.3 else rng.randint(1, 4)
        kw: dict[str, object] = {}
        if rng.random() < 0.25:
            kw["calendar_id"] = "sat"
        roll = rng.random()
        if roll < 0.1:
            kw["percent_complete"] = 100.0
        elif roll < 0.2:
            kw.update(actual_start=MON, actual_finish=MON + timedelta(days=days))
            kw["percent_complete"] = 100.0
        elif roll < 0.3 and days:
            kw.update(actual_start=MON, percent_complete=50.0)
        tasks.append(_task(f"t{i}", days, **kw))
    deps = []
    for i in range(1, n):
        for p in rng.sample(range(i), k=min(i, rng.randint(1, 2))):
            deps.append(
                Dependency(
                    f"t{p}",
                    f"t{i}",
                    rng.choice(list(DependencyType)),
                    timedelta(days=rng.randint(-1, 3)),
                )
            )
    return Project(
        id="f",
        name="f",
        start_date=MON,
        tasks=tasks,
        dependencies=deps,
        status_date=MON + timedelta(days=rng.randint(0, 5)),
        calendars={"sat": SAT_CAL},
    )


def test_kept_state_matches_replay_on_random_networks() -> None:
    rng = random.Random(4524)
    accepted = with_milestone = 0
    attempts = 120
    for _ in range(attempts):
        project = _random_project(rng, rng.randint(4, 25))
        try:
            schedule(project)
        except (InvalidScheduleInput, SchedulerError):
            continue
        accepted += 1
        with_milestone += any(t.duration.days == 0 for t in project.tasks)
        _assert_equivalent(project)
    # A generator the validator mostly rejects tests nothing (scheduler-engine skill).
    assert accepted >= attempts * 0.8, accepted
    assert with_milestone >= accepted * 0.8, with_milestone


def _milestone_project() -> Project:
    return _grid_project(DependencyType.FS, 1, "live", "live", per_task_cal=False)


def test_derive_with_schedules_result_does_not_replay(monkeypatch: pytest.MonkeyPatch) -> None:
    """The perf guard: a result from schedule(project) never re-runs the passes."""
    project = _milestone_project()
    result = schedule(project)

    def boom(*_a: object, **_k: object) -> object:
        raise AssertionError("derive_value replayed the CPM passes")

    monkeypatch.setattr(engine, "_milestone_instants", boom)
    monkeypatch.setattr(engine, "_project_free_instants", boom)
    monkeypatch.setattr(engine, "_forward_pass", boom)
    monkeypatch.setattr(engine, "_backward_pass", boom)
    for task in project.tasks:
        for q in QUANTITIES:
            derive_value(project, task.id, q, result)


def test_derive_without_a_result_schedules_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """``result=None`` pays one pass (inside schedule()), not a second replay."""
    project = _milestone_project()
    calls = {"n": 0}
    real = engine._forward_pass

    def counting(*a: object, **k: object) -> object:
        calls["n"] += 1
        return real(*a, **k)  # type: ignore[arg-type]

    monkeypatch.setattr(engine, "_forward_pass", counting)
    derive_value(project, "B", Quantity.LATE_START)
    assert calls["n"] == 1


def test_another_project_object_falls_back_to_the_replay(monkeypatch: pytest.MonkeyPatch) -> None:
    """An equal-but-distinct project is not trusted with the kept state."""
    project = _milestone_project()
    result = schedule(project)
    twin = dataclasses.replace(project)
    calls = {"n": 0}
    real = engine._milestone_instants

    def counting(p: Project) -> object:
        calls["n"] += 1
        return real(p)

    monkeypatch.setattr(engine, "_milestone_instants", counting)
    assert derive_value(twin, "B", Quantity.LATE_START, result) == derive_value(
        project, "B", Quantity.LATE_START, result
    )
    assert calls["n"] == 1


def test_milestone_free_project_keeps_nothing() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("A", 2), _task("B", 3)],
        dependencies=[Dependency("A", "B", DependencyType.FS, timedelta(0))],
    )
    result = schedule(project)
    assert getattr(result, engine._MILESTONE_REPLAY_ATTR, None) is None


def test_kept_state_is_invisible_to_the_public_surface() -> None:
    """Off the dataclass: fields, equality and to_dict() are what they were."""
    project = _milestone_project()
    result = schedule(project)
    assert engine._MILESTONE_REPLAY_ATTR not in {f.name for f in dataclasses.fields(result)}
    assert result == dataclasses.replace(result)
    assert result.to_dict() == dataclasses.replace(result).to_dict()


def test_a_pickled_or_copied_result_drops_the_kept_state() -> None:
    """The weak reference cannot be pickled; the result still pickles, minus the cache."""
    import copy
    import pickle

    project = _milestone_project()
    result = schedule(project)
    for clone in (pickle.loads(pickle.dumps(result)), copy.copy(result), copy.deepcopy(result)):
        assert clone == result
        assert getattr(clone, engine._MILESTONE_REPLAY_ATTR, None) is None
        assert derive_value(project, "B", Quantity.LATE_START, clone) == derive_value(
            project, "B", Quantity.LATE_START, result
        )
