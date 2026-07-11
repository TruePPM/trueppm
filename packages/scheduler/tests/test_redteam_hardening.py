"""Red-team hardening regression tests (#1205, #1206, #1207, #1208, #1209).

Covers the perf/DoS and input-contract findings from the 2026-06-15 scheduler
red-team audit:

* #1205 — vectorised Monte Carlo lag-delta build (must stay byte-for-byte
  equivalent to the scalar reference, and not regress the CPM↔MC parity).
* #1206 — calendar exception count cap + the bisect-indexed ``is_working_day``
  (must match the former linear ``any()`` scan exactly).
* #1207 — ``Project.from_json`` only raises the documented exception types on
  untrusted input (RecursionError / OverflowError / AttributeError closed).
* #1208 — ``expand_summary_dependencies`` cross-product cap.
* #1209 — public-API type-confusion contract breaks (find_cycle, direct calls).
"""

from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    expand_summary_dependencies,
    find_cycle,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.models import DateRange

DEP_TYPES = list(DependencyType)


# ---------------------------------------------------------------------------
# #1205 — vectorised lag-delta build
# ---------------------------------------------------------------------------


def _random_deterministic_project(seed: int) -> Project:
    r = random.Random(seed)
    n = r.randint(2, 7)
    tasks = [
        Task(id=f"t{i}", name=f"T{i}", duration=timedelta(days=r.randint(0, 6))) for i in range(n)
    ]
    deps: list[Dependency] = []
    for j in range(n):
        for i in range(j):  # i<j keeps the graph acyclic
            if r.random() < 0.35:
                deps.append(
                    Dependency(
                        predecessor_id=f"t{i}",
                        successor_id=f"t{j}",
                        dep_type=r.choice(DEP_TYPES),
                        lag=timedelta(days=r.randint(-3, 5)),
                    )
                )
    return Project(id="p", name="p", start_date=date(2026, 1, 5), tasks=tasks, dependencies=deps)


@pytest.mark.parametrize("seed", range(400))
def test_deterministic_monte_carlo_collapses_to_cpm(seed: int) -> None:
    """A project with no PERT/velocity uncertainty must simulate to exactly the CPM
    finish — every run and every percentile. This is the end-to-end proof that the
    vectorised ``_build_delta`` (all 4 dep types, +/- lag, SF +1) matches the scalar
    arithmetic it replaced (#1205); a wrong delta would shift the MC finish off CPM.
    """
    project = _random_deterministic_project(seed)
    # No try/except skip here: the generator's bounds (2-7 tasks, 0-6 day
    # durations, lag in [-3, 5]) sit entirely inside every validator cap, so no
    # legitimately degenerate project exists. Wrapping schedule() in a
    # skip-on-InvalidScheduleInput would let a validation regression that starts
    # rejecting valid projects silently convert this 400-case differential oracle
    # into 400 green skips (#1511). Let any rejection fail loudly instead.
    result = schedule(project)
    mc = monte_carlo(project, runs=48, seed=1, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish
    assert all(d == result.project_finish for d in mc.distribution)


def test_lag_delta_build_is_fast_with_many_distinct_lags() -> None:
    """The pathological 'many distinct lags' input (#1205) no longer drives a
    multi-second pure-Python build. Vectorised, it stays well under a second."""
    import time

    tasks = [Task(id=f"t{i}", name="x", duration=timedelta(0)) for i in range(120)]
    deps = [
        Dependency(
            predecessor_id=f"t{i}",
            successor_id=f"t{i + 1}",
            dep_type=DependencyType.FS,
            lag=timedelta(days=(i % 100) + 1),
        )
        for i in range(119)
    ]
    project = Project(id="p", name="p", start_date=date(2026, 1, 5), tasks=tasks, dependencies=deps)
    t0 = time.perf_counter()
    monte_carlo(project, runs=200, seed=1)
    assert time.perf_counter() - t0 < 2.0


# ---------------------------------------------------------------------------
# #1206 — bisect-indexed is_working_day + exception cap
# ---------------------------------------------------------------------------


def _linear_is_working_day(cal: Calendar, d: date) -> bool:
    """The former O(E) reference implementation."""
    if not (cal.working_days >> d.weekday()) & 1:
        return False
    return not any(exc.start <= d <= exc.end for exc in cal.exceptions)


@pytest.mark.parametrize("seed", range(50))
def test_bisect_is_working_day_matches_linear_scan(seed: int) -> None:
    """The cached merged-interval bisect must return identical results to the old
    linear scan for arbitrary (including overlapping/adjacent) exception sets."""
    r = random.Random(seed)
    base = date(2026, 1, 1)
    exceptions = []
    for _ in range(r.randint(0, 40)):
        start = base + timedelta(days=r.randint(0, 800))
        end = start + timedelta(days=r.randint(0, 20))
        exceptions.append(DateRange(start, end))
    cal = Calendar(working_days=r.randint(1, 127), exceptions=exceptions)
    for _ in range(200):
        d = base + timedelta(days=r.randint(-50, 900))
        assert cal.is_working_day(d) == _linear_is_working_day(cal, d)


def test_exception_index_rebuilds_when_list_grows() -> None:
    """A mutated/grown exceptions list must invalidate the cached index."""
    cal = Calendar(exceptions=[DateRange(date(2026, 3, 2), date(2026, 3, 2))])
    assert cal.is_working_day(date(2026, 3, 3)) is True  # Tuesday, not excepted
    cal.exceptions.append(DateRange(date(2026, 3, 3), date(2026, 3, 3)))
    assert cal.is_working_day(date(2026, 3, 3)) is False  # now excepted


def test_too_many_calendar_exceptions_rejected() -> None:
    exc = [DateRange(date(2027, 1, 1), date(2027, 1, 1)) for _ in range(100_001)]
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 1, 5),
        tasks=[Task(id="a", name="a", duration=timedelta(days=1))],
        calendar=Calendar(exceptions=exc),
    )
    with pytest.raises(InvalidScheduleInput, match="exception ranges"):
        schedule(project)


# ---------------------------------------------------------------------------
# #1207 — from_json / overflow exception contract
# ---------------------------------------------------------------------------


def test_deeply_nested_json_raises_documented_type() -> None:
    payload = "[" * 20_000 + "1" + "]" * 20_000
    with pytest.raises(InvalidScheduleInput):
        Project.from_json(payload)


def _year_9999_overflow_project() -> Project:
    return Project.from_json(
        json.dumps(
            {
                "id": "p",
                "name": "P",
                "start_date": "9999-01-01",
                "tasks": [{"id": "t", "name": "n", "duration": 36525 * 86400}],
            }
        )
    )


def test_date_overflow_rejected_on_schedule() -> None:
    with pytest.raises(InvalidScheduleInput):
        schedule(_year_9999_overflow_project())


def test_date_overflow_rejected_on_monte_carlo() -> None:
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(_year_9999_overflow_project(), max_runs=None, max_tasks=None)


@pytest.mark.parametrize("payload", ["[1,2,3]", "42", '"hello"'])
def test_non_object_top_level_json_rejected(payload: str) -> None:
    with pytest.raises(InvalidScheduleInput):
        Project.from_json(payload)


def test_non_object_calendar_rejected() -> None:
    doc = '{"id":"p","name":"p","start_date":"2026-01-05","tasks":[],"calendar":"nope"}'
    with pytest.raises(InvalidScheduleInput):
        Project.from_json(doc)


# ---------------------------------------------------------------------------
# #1208 — expand_summary_dependencies cap
# ---------------------------------------------------------------------------


def test_expand_summary_cross_product_capped() -> None:
    leaves_a = [f"a{i}" for i in range(1000)]
    leaves_b = [f"b{i}" for i in range(1000)]
    tasks = [Task(id=x, name=x, duration=timedelta(days=1)) for x in leaves_a + leaves_b]
    deps = [Dependency(predecessor_id="A", successor_id="B")]
    with pytest.raises(InvalidScheduleInput, match="exceed"):
        expand_summary_dependencies(tasks, deps, {"A": leaves_a, "B": leaves_b})


def test_expand_summary_small_still_works() -> None:
    """A modest summary→summary edge still expands to the full cross product."""
    tasks = [Task(id=x, name=x, duration=timedelta(days=1)) for x in ("a1", "a2", "b1", "b2")]
    deps = [Dependency(predecessor_id="A", successor_id="B")]
    leaf_tasks, expanded = expand_summary_dependencies(
        tasks, deps, {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    )
    assert {t.id for t in leaf_tasks} == {"a1", "a2", "b1", "b2"}
    assert {(d.predecessor_id, d.successor_id) for d in expanded} == {
        ("a1", "b1"),
        ("a1", "b2"),
        ("a2", "b1"),
        ("a2", "b2"),
    }


# ---------------------------------------------------------------------------
# #1209 — public-API type confusion
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "edges,children_map",
    [
        ([("a",)], None),
        (None, None),
        ([("a", "b")], {"a": 5}),
        ([(["a"], "b")], None),
        ([("a", 3)], None),
    ],
)
def test_find_cycle_rejects_malformed_input(edges: object, children_map: object) -> None:
    with pytest.raises(InvalidScheduleInput):
        find_cycle(edges, children_map)  # type: ignore[arg-type]


def test_find_cycle_still_detects_and_clears() -> None:
    assert find_cycle([("a", "b"), ("b", "a")]).cycle is not None
    assert find_cycle([("a", "b"), ("b", "c")]).cycle is None


def _one_task(**kw: object) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 1, 5),
        tasks=[Task(id="a", name="a", duration=timedelta(days=1), **kw)],  # type: ignore[arg-type]
    )


def test_direct_object_type_confusion_rejected() -> None:
    with pytest.raises(InvalidScheduleInput):
        schedule(
            Project(
                id="p",
                name="p",
                start_date=date(2026, 1, 5),
                tasks=[Task(id="a", name="a", duration=None)],  # type: ignore[arg-type]
            )
        )
    with pytest.raises(InvalidScheduleInput):
        schedule(_one_task(planned_start=datetime(2026, 1, 6)))  # datetime, not date
    with pytest.raises(InvalidScheduleInput):
        schedule(
            Project(
                id="p",
                name="p",
                start_date=date(2026, 1, 5),
                tasks=[Task(id="a", name="a", duration=timedelta(days=1))],
                calendar=Calendar(working_days="31"),  # type: ignore[arg-type]
            )
        )


def test_velocity_samples_non_numeric_rejected() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 1, 5),
        tasks=[Task(id="a", name="a", duration=timedelta(days=1))],
        velocity_samples=["fast"],  # type: ignore[list-item]
        sprint_length_days=10,
    )
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project)


def test_task_from_dict_direct_bad_planned_start() -> None:
    with pytest.raises(InvalidScheduleInput):
        Task.from_dict({"id": "t", "name": "n", "duration": 1, "planned_start": 12345})


def test_calendar_from_dict_bad_working_days() -> None:
    for bad in ("31", -1, 31.5, 999):
        with pytest.raises(InvalidScheduleInput):
            Calendar.from_dict({"working_days": bad})


# ---------------------------------------------------------------------------
# #1452 — percent_complete unvalidated in the direct-object API
# ---------------------------------------------------------------------------


def _one_task_project(**task_kw: object) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 1, 5),
        tasks=[Task(id="a", name="a", duration=timedelta(days=5), **task_kw)],  # type: ignore[arg-type]
    )


@pytest.mark.parametrize("bad_pct", [float("nan"), float("inf"), float("-inf")])
def test_percent_complete_nonfinite_rejected_by_both_passes(bad_pct: float) -> None:
    """A non-finite percent_complete used to crash schedule() with a bare ValueError
    (int(nan)) while monte_carlo() silently forecast it as 0% — the two passes
    diverging on identical input (#1452). Both must now reject it identically with
    the documented InvalidScheduleInput."""
    project = _one_task_project(percent_complete=bad_pct)
    with pytest.raises(InvalidScheduleInput):
        schedule(project)
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=12, seed=1)


def test_percent_complete_non_numeric_rejected() -> None:
    """A non-numeric percent_complete leaked a bare TypeError from the ``>= 100``
    compare; it must raise InvalidScheduleInput instead (#1452)."""
    project = _one_task_project(percent_complete="50")  # type: ignore[arg-type]
    with pytest.raises(InvalidScheduleInput):
        schedule(project)
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=12, seed=1)


@pytest.mark.parametrize("pct", [None, -10.0, 150.0, 0.0, 100.0, 42.0])
def test_percent_complete_finite_in_or_out_of_range_is_clamped_not_rejected(pct: float) -> None:
    """Documented out-of-range policy (#1452): None and finite values outside
    [0, 100] are *clamped* (consistent with from_dict / both passes' ``min(pct, 100)``),
    not rejected — only non-finite / non-numeric input breaks the contract. Both
    passes must therefore accept every value here without raising.

    The two passes need not agree on the finish: a task clamped to complete
    (``pct >= 100``) carries zero remaining work, so monte_carlo (which forecasts
    *remaining* duration) finishes at the project start while the deterministic CPM
    finish is start + duration. The invariant that always holds is that the
    percentiles are monotone and never exceed the deterministic finish."""
    project = _one_task_project(percent_complete=pct)
    result = schedule(project)
    mc = monte_carlo(project, runs=16, seed=1, max_runs=None, max_tasks=None)
    assert result.project_finish is not None
    assert mc.p50 <= mc.p80 <= mc.p95 <= result.project_finish


# ---------------------------------------------------------------------------
# #1453 — monte_carlo() seed unvalidated
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_seed", [-1, -99, 2.5, float("nan"), True, "1"])
def test_monte_carlo_bad_seed_rejected(bad_seed: object) -> None:
    """A negative/float/non-int seed used to escape as a bare numpy ValueError/
    TypeError; it must raise the documented InvalidScheduleInput instead (#1453)."""
    project = _one_task_project()
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=12, seed=bad_seed)  # type: ignore[arg-type]


@pytest.mark.parametrize("good_seed", [None, 0, 7, 10**9])
def test_monte_carlo_good_seed_accepted(good_seed: object) -> None:
    """None and any non-negative int remain valid seeds (#1453)."""
    project = _one_task_project()
    monte_carlo(project, runs=12, seed=good_seed)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# #1823 — Project.start_date unvalidated in the direct-object API
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_start", [None, "2026-01-01", 20260101, datetime(2026, 1, 1)])
def test_project_start_date_non_date_rejected(bad_start: object) -> None:
    """start_date feeds every calendar walk via ``.weekday()``; a non-date (or a
    datetime, which mixes badly with date arithmetic) used to leak a bare
    AttributeError/TypeError past the contract on the direct-object path the Django
    API uses (#1823). Both entry points must reject it with InvalidScheduleInput."""
    project = Project(
        id="p",
        name="p",
        start_date=bad_start,  # type: ignore[arg-type]
        tasks=[Task(id="a", name="a", duration=timedelta(days=1))],
    )
    with pytest.raises(InvalidScheduleInput):
        schedule(project)
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=12, seed=1)


# ---------------------------------------------------------------------------
# #1825 — public-API type-guard gaps (children_map, monte_carlo runs)
# ---------------------------------------------------------------------------


def test_find_cycle_non_dict_children_map_rejected() -> None:
    """find_cycle validated children_map *values* but not that the map itself is a
    dict, leaking a bare AttributeError from ``.items()`` (#1825)."""
    for bad_map in (["a", "b"], "ab", 5):
        with pytest.raises(InvalidScheduleInput):
            find_cycle([("a", "b")], children_map=bad_map)  # type: ignore[arg-type]


def test_expand_summary_dependencies_non_list_child_value_rejected() -> None:
    """expand_summary_dependencies is the twin of find_cycle but skipped the
    value-type guard (#1825). A non-list value leaked a bare TypeError from
    reversed(); a *string* value was worse — it silently iterated characters as
    child ids, producing corrupt expanded dependencies with no error."""
    tasks = [Task(id="L", name="L", duration=timedelta(days=1))]
    deps = [Dependency(predecessor_id="S", successor_id="L", dep_type=DependencyType.FS)]
    for bad_value in (5, "xy", None):
        with pytest.raises(InvalidScheduleInput):
            expand_summary_dependencies(tasks, deps, {"S": bad_value})  # type: ignore[dict-item]


def test_expand_summary_dependencies_non_dict_children_map_rejected() -> None:
    """A non-dict (but truthy) children_map reached ``.items()`` in
    _check_children_map and leaked a bare AttributeError (#1825)."""
    tasks = [Task(id="L", name="L", duration=timedelta(days=1))]
    deps = [Dependency(predecessor_id="S", successor_id="L", dep_type=DependencyType.FS)]
    with pytest.raises(InvalidScheduleInput):
        expand_summary_dependencies(tasks, deps, ["S"])  # type: ignore[arg-type]


@pytest.mark.parametrize("bad_runs", ["10", 1.5, True, None])
def test_monte_carlo_non_int_runs_rejected(bad_runs: object) -> None:
    """runs sizes ``np.empty((runs, ...))``; a str tripped ``runs < 1`` and a float
    tripped np.empty, both leaking a bare TypeError. Mirrors the seed guard (#1825)."""
    project = _one_task_project()
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=bad_runs)  # type: ignore[arg-type]


@pytest.mark.parametrize("good_runs", [1, 12, 1000])
def test_monte_carlo_int_runs_accepted(good_runs: int) -> None:
    """A positive int remains a valid run count (#1825)."""
    monte_carlo(_one_task_project(), runs=good_runs, seed=1)


# ---------------------------------------------------------------------------
# #1822 — MAX_EXPANDED_EDGES bypass via exponential leaf materialization
# ---------------------------------------------------------------------------


def _doubling_children_map(depth: int) -> dict[str, list[str]]:
    """A valid, acyclic children_map with 2**depth root-to-leaf paths to one leaf.

    Each summary points at the next level *twice*, so ``_collect_leaves`` yields the
    single leaf 2**depth times — the exponential list that used to blow up before the
    MAX_EXPANDED_EDGES guard (which reads its length) ran (#1822)."""
    return {f"s{i}": [f"s{i + 1}", f"s{i + 1}"] for i in range(depth)}


@pytest.mark.parametrize("depth", [25, 40, 200])
def test_collect_leaves_exponential_map_rejected_fast(depth: int) -> None:
    """A doubling children_map must be rejected in bounded time via find_cycle and
    expand_summary_dependencies — not materialize a 2**depth list first (#1822).
    Depth 40 would be ~10**12 paths and hang for minutes without the in-traversal cap.
    """
    import time

    cmap = _doubling_children_map(depth)
    edges = [("s0", f"s{depth}")]
    t0 = time.perf_counter()
    with pytest.raises(InvalidScheduleInput):
        find_cycle(edges, children_map=cmap)
    assert time.perf_counter() - t0 < 2.0

    tasks = [Task(id=f"s{depth}", name="leaf", duration=timedelta(days=1))]
    deps = [Dependency(predecessor_id="s0", successor_id=f"s{depth}")]
    t0 = time.perf_counter()
    with pytest.raises(InvalidScheduleInput):
        expand_summary_dependencies(tasks, deps, cmap)
    assert time.perf_counter() - t0 < 2.0


# ---------------------------------------------------------------------------
# #1824 — repeated unbounded calendar scans in the forward pass
# ---------------------------------------------------------------------------


def test_forward_pass_snap_memoized_over_blanket_calendar() -> None:
    """A valid calendar whose exceptions blanket a ~36k-day gap after the start
    (one working day just past it, so validation's reachability probe passes) used to
    make schedule() O(tasks · scan_depth): every task repeated the same 36k-day snap.
    Memoizing the per-calendar snap (#1824) keeps a many-task schedule fast."""
    import time

    cal = Calendar(
        working_days=0b0011111,
        exceptions=[DateRange(date(2026, 1, 7), date(2026, 1, 7) + timedelta(days=36000))],
    )
    tasks = [Task(id=f"t{i}", name=f"t{i}", duration=timedelta(days=1)) for i in range(200)]
    project = Project(
        id="p", name="p", start_date=date(2026, 1, 5), tasks=tasks, dependencies=[], calendar=cal
    )
    t0 = time.perf_counter()
    result = schedule(project)
    assert time.perf_counter() - t0 < 2.0
    # Only Jan 5 (Mon) and Jan 6 (Tue) are workable before the blanket; every
    # dependency-free 1-day task snaps to the project start.
    assert result.project_finish == date(2026, 1, 5)
