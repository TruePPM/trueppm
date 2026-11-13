"""Pickle round-trips for the public model and result types (#4448).

``multiprocessing``, Dask and Ray ship ``Project`` in and ``ScheduleResult`` out by
pickling, so each public type must survive ``loads(dumps(x))`` equal to the
original, and scheduling the unpickled input must give the same answer. These also
guard the ``slots=True`` change (#4548), which alters default pickle behavior.
"""

from __future__ import annotations

import copyreg
import pickle
from concurrent.futures import ProcessPoolExecutor
from datetime import date, timedelta
from typing import Any

import pytest

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    Project,
    Task,
    derive_value,
    monte_carlo,
    schedule,
)

_PROTOCOLS = list(range(pickle.HIGHEST_PROTOCOL + 1))


def _calendar() -> Calendar:
    return Calendar(
        working_days=0b0011111,
        exceptions=[
            DateRange(date(2026, 1, 19), date(2026, 1, 19)),
            DateRange(date(2026, 2, 2), date(2026, 2, 4)),
        ],
    )


def _project() -> Project:
    return Project(
        id="p",
        name="Pickle",
        start_date=date(2026, 1, 5),
        calendar=_calendar(),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=5)),
            Task(
                id="B",
                name="B",
                duration=timedelta(days=4),
                optimistic_duration=timedelta(days=2),
                most_likely_duration=timedelta(days=4),
                pessimistic_duration=timedelta(days=9),
            ),
            Task(id="C", name="C", duration=timedelta(days=3)),
            Task(id="M", name="M", duration=timedelta(0)),
        ],
        dependencies=[
            Dependency("A", "B", DependencyType.FS, lag=timedelta(days=1)),
            Dependency("A", "C", DependencyType.SS),
            Dependency("B", "M", DependencyType.FS),
            Dependency("C", "M", DependencyType.FF),
        ],
    )


def _roundtrip(obj: Any, protocol: int) -> Any:
    return pickle.loads(pickle.dumps(obj, protocol=protocol))


@pytest.mark.parametrize("protocol", _PROTOCOLS)
class TestRoundTrip:
    def test_task(self, protocol: int) -> None:
        task = _project().tasks[1]
        assert _roundtrip(task, protocol) == task

    def test_scheduled_task_keeps_computed_fields(self, protocol: int) -> None:
        task = schedule(_project()).tasks[0]
        assert task.early_finish is not None
        assert _roundtrip(task, protocol) == task

    def test_dependency(self, protocol: int) -> None:
        dep = _project().dependencies[0]
        assert _roundtrip(dep, protocol) == dep

    def test_date_range(self, protocol: int) -> None:
        rng = DateRange(date(2026, 1, 1), date(2026, 1, 3))
        assert _roundtrip(rng, protocol) == rng

    def test_calendar_with_exceptions(self, protocol: int) -> None:
        cal = _calendar()
        copy = _roundtrip(cal, protocol)
        assert copy == cal
        assert isinstance(copy.exceptions, tuple)
        for d in (date(2026, 1, 19), date(2026, 2, 3), date(2026, 1, 20), date(2026, 1, 24)):
            assert copy.is_working_day(d) == cal.is_working_day(d)

    def test_calendar_with_a_warm_cache(self, protocol: int) -> None:
        """The lazy exception index is built on first use; a pickle taken after must still work."""
        cal = _calendar()
        cal.is_working_day(date(2026, 1, 19))  # builds the cache
        copy = _roundtrip(cal, protocol)
        assert copy == cal
        assert copy.is_working_day(date(2026, 1, 19)) is False
        assert copy.is_working_day(date(2026, 1, 20)) is True

    def test_calendar_unpickled_is_still_normalized_and_cached(self, protocol: int) -> None:
        copy = _roundtrip(_calendar(), protocol)
        copy.exceptions = [DateRange(date(2026, 3, 2), date(2026, 3, 2))]  # type: ignore[assignment]
        assert isinstance(copy.exceptions, tuple)
        assert copy.is_working_day(date(2026, 3, 2)) is False
        assert copy.is_working_day(date(2026, 1, 19)) is True  # old exception is gone

    def test_project_equal_and_schedules_identically(self, protocol: int) -> None:
        project = _project()
        copy = _roundtrip(project, protocol)
        assert copy == project
        assert schedule(copy) == schedule(project)

    def test_schedule_result(self, protocol: int) -> None:
        project = _project()
        result = schedule(project)
        copy = _roundtrip(result, protocol)
        assert copy == result
        assert copy.to_dict() == result.to_dict()

    def test_schedule_result_unpickled_still_derives(self, protocol: int) -> None:
        """The result's weakref replay cache is dropped on pickle; derive still works."""
        project = _project()
        result = schedule(project)
        copy = _roundtrip(result, protocol)
        assert derive_value(project, "M", "early_start", copy) == derive_value(
            project, "M", "early_start", result
        )

    def test_monte_carlo_result(self, protocol: int) -> None:
        result = monte_carlo(_project(), runs=200, seed=7)
        copy = _roundtrip(result, protocol)
        assert copy == result
        assert copy.to_dict() == result.to_dict()

    def test_derivation(self, protocol: int) -> None:
        derivation = derive_value(_project(), "M", "early_start")
        copy = _roundtrip(derivation, protocol)
        assert copy == derivation
        assert copy.to_dict() == derivation.to_dict()


def _schedule_in_worker(project: Project) -> Any:
    return schedule(project)


def test_process_pool_round_trip() -> None:
    """Project goes to a worker process and ScheduleResult comes back, both by pickle."""
    project = _project()
    with ProcessPoolExecutor(max_workers=1) as pool:
        remote = pool.submit(_schedule_in_worker, project).result(timeout=60)
    assert remote == schedule(project)


def _dumps_unslotted(obj: Any, state: dict[str, Any], protocol: int) -> bytes:
    """Pickle ``obj`` the way a pre-``slots=True`` release did: ``{field: value}`` state."""
    import io

    class _Pickler(pickle.Pickler):
        def reducer_override(self, o: Any) -> Any:
            if o is not obj:
                return NotImplemented
            if protocol >= 2:
                return (copyreg.__newobj__, (type(o),), state)
            return (copyreg._reconstructor, (type(o), object, None), state)

    buf = io.BytesIO()
    _Pickler(buf, protocol).dump(obj)
    return buf.getvalue()


@pytest.mark.parametrize("protocol", _PROTOCOLS)
def test_pickle_written_before_slots_still_loads(protocol: int) -> None:
    """A 0.4 pickle holds a ``__dict__`` state; slotted classes must still accept it (#4548)."""
    project = _project()
    task = project.tasks[1]
    task_state = {f: getattr(task, f) for f in task.__slots__}
    assert pickle.loads(_dumps_unslotted(task, task_state, protocol)) == task
    cal = project.calendar
    cal_state = {
        "working_days": cal.working_days,
        "exceptions": cal.exceptions,
        "hours_per_day": cal.hours_per_day,
        "timezone": cal.timezone,
    }
    # No ``_exc_cache`` key: the slot must fall back to its default, not stay unset.
    legacy_cal = pickle.loads(_dumps_unslotted(cal, cal_state, protocol))
    assert legacy_cal == cal
    assert legacy_cal.is_working_day(date(2026, 1, 19)) is False


def test_shallow_and_deep_copy_of_slotted_models() -> None:
    """``schedule()`` shallow-copies every task; ``copy`` must keep working on slots (#4548)."""
    import copy

    project = _project()
    task = project.tasks[1]
    shallow = copy.copy(task)
    assert shallow == task
    assert shallow is not task
    shallow.name = "changed"
    assert task.name == "B"
    assert copy.deepcopy(project) == project
    cal = copy.copy(project.calendar)
    assert cal == project.calendar
    cal.exceptions = []  # type: ignore[assignment]
    assert cal.exceptions == ()  # Calendar's __setattr__ normalization still applies to a copy
    assert project.calendar.exceptions != ()
