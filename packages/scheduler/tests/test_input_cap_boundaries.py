"""Every exported ``MAX_*`` input cap is pinned at its boundary (#4545).

A cap is a comparison, and the comparison is the thing that rots: flipping ``>`` to
``>=`` on ``MAX_CALENDAR_EXCEPTIONS`` survived a 3,213-test suite because the only
reference to the constant asserted that it was exported. Each case here builds an
input at *exactly* the cap (accepted) and one unit past it (rejected with the
documented exception type), so an off-by-one in either direction fails by name.

The parameter list is generated from the modules' exports, and
``test_every_exported_cap_has_a_boundary_case`` fails for any ``MAX_*`` name without
a case, so a new cap cannot ship without one.

Most caps are enforced by ``_validate_project``; the cell budgets are Monte Carlo
parameters (the constant is only their default) and the velocity horizon is a clamp,
not a refusal, so those cases state their own boundary.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from itertools import pairwise

import numpy as np
import pytest

import trueppm_scheduler
from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    SimulationCapExceeded,
    Task,
    find_cycle,
    monte_carlo,
)
from trueppm_scheduler import engine as engine_pkg
from trueppm_scheduler.engine import (
    _sample_velocity_durations,
    _snap_to_working_day,
    _validate_project,
    expand_summary_dependencies,
    limits,
)
from trueppm_scheduler.models import DateRange

_MONDAY = date(2026, 3, 2)


def _exported_caps() -> dict[str, int]:
    """Every public ``MAX_*`` integer exported by the package, the engine, or ``limits``."""
    caps: dict[str, int] = {}
    for module in (trueppm_scheduler, engine_pkg, limits):
        for name in dir(module):
            value = getattr(module, name)
            if name.startswith("MAX_") and isinstance(value, int) and not isinstance(value, bool):
                assert caps.setdefault(name, value) == value, f"{name} differs between modules"
    return caps


def _task(tid: str, days: int) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days))


def _project(
    tasks: list[Task],
    deps: list[Dependency] | None = None,
    calendar: Calendar | None = None,
    calendars: dict[str, Calendar] | None = None,
) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=_MONDAY,
        tasks=tasks,
        dependencies=deps or [],
        calendar=calendar or Calendar(),
        calendars=calendars,
    )


def _chain(tasks: list[Task]) -> list[Dependency]:
    return [Dependency(a.id, b.id, DependencyType.FS) for a, b in pairwise(tasks)]


def _rejects(project: Project) -> None:
    with pytest.raises(InvalidScheduleInput):
        _validate_project(project)


# ---------------------------------------------------------------------------
# One builder per cap. ``at`` must be accepted, ``over`` must be refused.
# ---------------------------------------------------------------------------


_DURATION_FIELDS = (
    "duration",
    "optimistic_duration",
    "most_likely_duration",
    "pessimistic_duration",
)


def _duration(field: str, n: int) -> Project:
    """One task whose ``field`` is ``n`` days; the plain fast path and each PERT leg differ."""
    fields = {"duration": timedelta(days=1), field: timedelta(days=n)}
    return _project([Task(id="A", name="A", **fields)])


def _lag(n: int) -> Project:
    deps = [Dependency("A", "B", DependencyType.FS, lag=timedelta(days=n))]
    return _project([_task("A", 1), _task("B", 1)], deps)


def _chain_span(total: int) -> Project:
    """A single dependency chain whose worst-case durations sum to ``total`` days."""
    per_task = limits.MAX_DURATION_DAYS
    full, rest = divmod(total, per_task)
    tasks = [_task(f"t{i}", per_task) for i in range(full)] + [_task("rest", rest)]
    return _project(tasks, _chain(tasks))


def _parallel_work(total: int) -> Project:
    """Parallel tasks summing to ``total`` days: the work bound without a longer span."""
    per_task = limits.MAX_DURATION_DAYS
    full, rest = divmod(total, per_task)
    return _project([_task(f"t{i}", per_task) for i in range(full)] + [_task("rest", rest)])


def _dependency_count(n: int) -> Project:
    """``n`` distinct forward edges between the fewest tasks that can hold them."""
    size = 2
    while size * (size - 1) // 2 < n:
        size += 1
    tasks = [_task(f"t{i}", 1) for i in range(size)]
    deps = [
        Dependency(f"t{i}", f"t{j}", DependencyType.FS)
        for i in range(size)
        for j in range(i + 1, size)
    ][:n]
    return _project(tasks, deps)


@cache
def _exception_ranges(n: int) -> tuple[DateRange, ...]:
    """``n`` disjoint one-day closures, every other day, leaving the start day working."""
    return tuple(
        DateRange(_MONDAY + timedelta(days=1 + 2 * i), _MONDAY + timedelta(days=1 + 2 * i))
        for i in range(n)
    )


def _exceptions_on_project_calendar(n: int) -> Project:
    return _project([_task("A", 1)], calendar=Calendar(exceptions=list(_exception_ranges(n))))


def _exceptions_on_registry_calendar(n: int) -> Project:
    registry = {"c": Calendar(exceptions=list(_exception_ranges(n)))}
    return _project([_task("A", 1)], calendars=registry)


def _expansion_inputs(
    extra_edge: bool,
) -> tuple[list[Task], list[Dependency], dict[str, list[str]]]:
    """A 250-leaf -> 400-leaf summary edge: exactly ``MAX_EXPANDED_EDGES`` leaf pairs."""
    left = [f"p{i}" for i in range(250)]
    right = [f"s{i}" for i in range(400)]
    tasks = [_task(tid, 1) for tid in [*left, *right]]
    deps = [Dependency("P", "S", DependencyType.FS)]
    if extra_edge:  # one more leaf pair tips the summed estimate past the cap
        tasks += [_task("x1", 1), _task("x2", 1)]
        deps.append(Dependency("x1", "x2", DependencyType.FS))
    return tasks, deps, {"P": left, "S": right}


def _expansion_at_cap() -> None:
    assert limits.MAX_EXPANDED_EDGES == 250 * 400
    tasks, deps, children = _expansion_inputs(extra_edge=False)
    edges = [(d.predecessor_id, d.successor_id) for d in deps]
    assert find_cycle(edges, children_map=children).cycle is None
    expanded = expand_summary_dependencies(tasks, deps, children)
    assert len(expanded.dependencies) == limits.MAX_EXPANDED_EDGES


def _expansion_over_cap() -> None:
    tasks, deps, children = _expansion_inputs(extra_edge=True)
    edges = [(d.predecessor_id, d.successor_id) for d in deps]
    with pytest.raises(InvalidScheduleInput, match="exceed"):
        find_cycle(edges, children_map=children)
    with pytest.raises(InvalidScheduleInput, match="exceed"):
        expand_summary_dependencies(tasks, deps, children)


def _snap_at_cap() -> None:
    """A closure run whose far edge is exactly ``MAX_CALENDAR_SCAN_DAYS`` away is crossed."""
    n = limits.MAX_CALENDAR_SCAN_DAYS
    forward = Calendar(exceptions=[DateRange(_MONDAY, _MONDAY + timedelta(days=n - 1))])
    assert _snap_to_working_day(_MONDAY, forward, forward=True) == _MONDAY + timedelta(days=n)
    # Backward from the run's last day to the working Monday just before it.
    run = DateRange(_MONDAY + timedelta(days=1), _MONDAY + timedelta(days=n))
    origin = _MONDAY + timedelta(days=n)
    assert _snap_to_working_day(origin, Calendar(exceptions=[run]), forward=False) == _MONDAY


def _snap_over_cap() -> None:
    n = limits.MAX_CALENDAR_SCAN_DAYS + 1
    forward = Calendar(exceptions=[DateRange(_MONDAY, _MONDAY + timedelta(days=n - 1))])
    with pytest.raises(InvalidScheduleInput):
        _snap_to_working_day(_MONDAY, forward, forward=True)
    run = DateRange(_MONDAY + timedelta(days=1), _MONDAY + timedelta(days=n))
    with pytest.raises(InvalidScheduleInput):
        _snap_to_working_day(_MONDAY + timedelta(days=n), Calendar(exceptions=[run]), forward=False)


def _mc_project_with_one_sf_edge() -> Project:
    """Two tasks joined by SF/lag-0: exactly one lag-delta array, one calendar."""
    deps = [Dependency("A", "B", DependencyType.SF)]
    return _project([_task("A", 2), _task("B", 2)], deps)


def _run_mc(project: Project, **caps: int) -> None:
    monte_carlo(project, runs=10, seed=0, max_tasks=None, **caps)


def _index_cells_boundary() -> tuple[int, Callable[[int], None]]:
    p = _mc_project_with_one_sf_edge()
    with pytest.raises(SimulationCapExceeded) as excinfo:
        _run_mc(p, max_index_cells=0)
    match = re.search(r"([\d,]+) distinct calendars x a ([\d,]+)-day index", str(excinfo.value))
    assert match, str(excinfo.value)
    cells = int(match.group(1).replace(",", "")) * int(match.group(2).replace(",", ""))
    return cells, lambda budget: _run_mc(p, max_index_cells=budget)


def _index_cells_at_cap() -> None:
    cells, run = _index_cells_boundary()
    run(cells)  # exactly the budget the project needs is accepted


def _index_cells_over_cap() -> None:
    cells, run = _index_cells_boundary()
    with pytest.raises(SimulationCapExceeded, match="would exceed"):
        run(cells - 1)


def _lag_delta_cells() -> tuple[int, Callable[[int], None]]:
    p = _mc_project_with_one_sf_edge()
    with pytest.raises(SimulationCapExceeded) as excinfo:
        _run_mc(p, max_index_cells=0)
    index_size = int(
        re.search(r"a ([\d,]+)-day index", str(excinfo.value)).group(1).replace(",", "")
    )  # type: ignore[union-attr]
    return index_size, lambda budget: _run_mc(p, max_lag_delta_cells=budget)


def _lag_delta_at_cap() -> None:
    cells, run = _lag_delta_cells()
    run(cells)  # one array x index_size cells fits a budget of exactly that


def _lag_delta_over_cap() -> None:
    cells, run = _lag_delta_cells()
    with pytest.raises(InvalidScheduleInput, match="lag-delta table"):
        run(cells - 1)


def _velocity_horizon(story_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Durations and saturation flags for a team that delivers exactly 1 point a sprint."""
    saturated = np.zeros(2, dtype=bool)
    out = _sample_velocity_durations(
        story_points,
        velocity_samples=[1.0],
        sprint_length_days=1,
        n=2,
        rng=np.random.default_rng(0),
        saturated=saturated,
    )
    assert out is not None
    return out, saturated


def _velocity_at_cap() -> None:
    # Needs exactly MAX_VELOCITY_SPRINTS sprints and the horizon is exactly that many:
    # the story completes on the last sprint instead of being cut off.
    out, saturated = _velocity_horizon(limits.MAX_VELOCITY_SPRINTS)
    assert not saturated.any()
    assert out.tolist() == [float(limits.MAX_VELOCITY_SPRINTS)] * 2


def _velocity_over_cap() -> None:
    # One sprint more than the horizon: clamped to it and flagged, never allowed past it.
    out, saturated = _velocity_horizon(limits.MAX_VELOCITY_SPRINTS + 1)
    assert saturated.all()
    assert out.tolist() == [float(limits.MAX_VELOCITY_SPRINTS)] * 2


@dataclass(frozen=True)
class BoundaryCase:
    """How to build the at-cap and past-cap input for one ``MAX_*`` constant."""

    at: Callable[[], None]
    over: Callable[[], None]


def _validated(build: Callable[[int], Project], cap: int) -> BoundaryCase:
    return BoundaryCase(
        at=lambda: _validate_project(build(cap)),
        over=lambda: _rejects(build(cap + 1)),
    )


def _duration_case(cap: int) -> BoundaryCase:
    """``Task.duration`` takes a validator fast path; each PERT field takes the full check."""

    def at() -> None:
        for field in _DURATION_FIELDS:
            _validate_project(_duration(field, cap))

    def over() -> None:
        for field in _DURATION_FIELDS:
            _rejects(_duration(field, cap + 1))

    return BoundaryCase(at=at, over=over)


def _lag_case(cap: int) -> BoundaryCase:
    """Lead and lag are bounded symmetrically, so both signs are pinned."""

    def at() -> None:
        for sign in (1, -1):
            _validate_project(_lag(sign * cap))

    def over() -> None:
        for sign in (1, -1):
            _rejects(_lag(sign * (cap + 1)))

    return BoundaryCase(at=at, over=over)


def _exceptions_case(cap: int) -> BoundaryCase:
    """The project calendar and the per-task calendar registry are checked separately."""
    builders = (_exceptions_on_project_calendar, _exceptions_on_registry_calendar)

    def at() -> None:
        for build in builders:
            _validate_project(build(cap))

    def over() -> None:
        for build in builders:
            _rejects(build(cap + 1))

    return BoundaryCase(at=at, over=over)


def _cases() -> dict[str, BoundaryCase]:
    caps = _exported_caps()
    return {
        "MAX_DURATION_DAYS": _duration_case(caps["MAX_DURATION_DAYS"]),
        "MAX_LAG_DAYS": _lag_case(caps["MAX_LAG_DAYS"]),
        "MAX_CALENDAR_SCAN_DAYS": BoundaryCase(at=_snap_at_cap, over=_snap_over_cap),
        "MAX_PROJECT_SPAN_DAYS": _validated(_chain_span, caps["MAX_PROJECT_SPAN_DAYS"]),
        "MAX_PROJECT_WORK_DAYS": _validated(_parallel_work, caps["MAX_PROJECT_WORK_DAYS"]),
        "MAX_EXPANDED_EDGES": BoundaryCase(at=_expansion_at_cap, over=_expansion_over_cap),
        "MAX_DEPENDENCIES": _validated(_dependency_count, caps["MAX_DEPENDENCIES"]),
        "MAX_CALENDAR_EXCEPTIONS": _exceptions_case(caps["MAX_CALENDAR_EXCEPTIONS"]),
        "MAX_LAG_DELTA_CELLS": BoundaryCase(at=_lag_delta_at_cap, over=_lag_delta_over_cap),
        "MAX_INDEX_CELLS": BoundaryCase(at=_index_cells_at_cap, over=_index_cells_over_cap),
        "MAX_VELOCITY_SPRINTS": BoundaryCase(at=_velocity_at_cap, over=_velocity_over_cap),
    }


_CASES = _cases()
_CAP_NAMES = sorted(_exported_caps())


@pytest.mark.parametrize("name", _CAP_NAMES)
def test_cap_accepts_input_exactly_at_the_cap(name: str) -> None:
    if name not in _CASES:
        pytest.fail(f"{name} is an exported cap with no boundary case; add one to _cases().")
    _CASES[name].at()


@pytest.mark.parametrize("name", _CAP_NAMES)
def test_cap_rejects_input_one_past_the_cap(name: str) -> None:
    if name not in _CASES:
        pytest.fail(f"{name} is an exported cap with no boundary case; add one to _cases().")
    _CASES[name].over()


def test_every_exported_cap_has_a_boundary_case() -> None:
    assert set(_CASES) == set(_exported_caps())


@pytest.mark.parametrize(
    ("param", "cap"),
    [("max_lag_delta_cells", "MAX_LAG_DELTA_CELLS"), ("max_index_cells", "MAX_INDEX_CELLS")],
)
def test_monte_carlo_cell_budgets_default_to_the_exported_cap(param: str, cap: str) -> None:
    """The cell cases probe the keyword, so pin that the keyword's default is the constant."""
    default = inspect.signature(monte_carlo).parameters[param].default
    assert default == _exported_caps()[cap]
