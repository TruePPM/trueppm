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


# ---------------------------------------------------------------------------
# #1821 — monte_carlo() undersized index clamped completed-task actuals
# ---------------------------------------------------------------------------


def test_monte_carlo_matches_schedule_for_late_completed_actual() -> None:
    """A task that finished long after its planned duration pins the project finish.
    The MC working-day index omitted an actuals term, so the pin mapped past the
    index end and clamped to the last entry — monte_carlo() reported a finish months
    before schedule() on the same fully-deterministic completed project (#1821)."""
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 1, 5),
        tasks=[
            # planned 5 days, actually finished ~5 months late
            Task(
                id="A",
                name="A",
                duration=timedelta(days=5),
                percent_complete=100.0,
                actual_finish=date(2026, 6, 1),
            ),
            Task(id="B", name="B", duration=timedelta(days=10)),
        ],
    )
    result = schedule(project)
    mc = monte_carlo(project, runs=300, seed=1, max_runs=None, max_tasks=None)
    assert result.project_finish == date(2026, 6, 1)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish


def test_monte_carlo_matches_schedule_for_late_actual_start_only() -> None:
    """The same undersizing hit a completed task recorded with only actual_start
    (a REVIEW task, done and awaiting sign-off) far in the future (#1821)."""
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 1, 5),
        tasks=[
            Task(
                id="A",
                name="A",
                duration=timedelta(days=5),
                percent_complete=100.0,
                actual_start=date(2026, 6, 1),
            ),
            Task(id="B", name="B", duration=timedelta(days=3)),
        ],
    )
    result = schedule(project)
    mc = monte_carlo(project, runs=300, seed=1, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish


# ---------------------------------------------------------------------------
# #1828 — free_float wrong when a lag's calendar-day arithmetic crosses
#          non-working days
# ---------------------------------------------------------------------------

# Each case: A links to B with a positive calendar-day lag that lands across a
# weekend. B's early date is driven by the lag itself (no other predecessor), so
# the whole weekend absorbs the lag — A can slip its *entire* total float without
# moving B's early date, i.e. free_float == total_float (2 working days here).
# The old proxy measured the working-day gap from A's forward-imposed date to B's
# early date, which collapsed to 0 exactly because the snap already consumed the
# weekend — reporting free_float 0 against a total_float of 2 (#1828). start_date
# 2026-03-02 is a Monday; the default calendar is Mon-Fri.
_ABSORBED_LAG_CASES = [
    # dep_type, A duration (days), lag (calendar days), B duration (days)
    (DependencyType.FS, 3, 2, 2),
    (DependencyType.SS, 2, 5, 2),
    (DependencyType.FF, 2, 4, 2),
    (DependencyType.SF, 2, 5, 2),
]


@pytest.mark.parametrize(("dep_type", "dur_a", "lag_days", "dur_b"), _ABSORBED_LAG_CASES)
def test_free_float_lag_absorbed_by_weekend(
    dep_type: DependencyType, dur_a: int, lag_days: int, dur_b: int
) -> None:
    """A calendar-day lag fully absorbed by a weekend must not zero out free float.

    Inverting the forward constraint (the fix) reports free_float == total_float ==
    2 working days; the old forward-imposed-date proxy reported 0 (#1828)."""
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=dur_a)),
            Task(id="B", name="B", duration=timedelta(days=dur_b)),
        ],
        dependencies=[
            Dependency(
                predecessor_id="A",
                successor_id="B",
                dep_type=dep_type,
                lag=timedelta(days=lag_days),
            )
        ],
    )
    a = {t.id: t for t in schedule(project).tasks}["A"]
    assert a.total_float == timedelta(days=2)
    assert a.free_float == timedelta(days=2)  # not 0 (the pre-fix proxy value)


def test_free_float_lag_understated_by_weekend() -> None:
    """The proxy also *under*-counted: a 1-cd FS lag that re-lands on the same
    working day as the predecessor slips leaves one full working day of true slack
    that the old code reported as 0 (#1828). A(4d) finishes Thu; +1cd FS pushes B
    to Mon regardless of whether A finishes Thu or Fri, so A has 1 day of free
    float. A long parallel pole (Z) gives A ample total float, so free float is
    strictly less than total float — proving the fix is not just clamping to it."""
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=4)),
            Task(id="B", name="B", duration=timedelta(days=1)),
            Task(id="Z", name="Z", duration=timedelta(days=20)),
        ],
        dependencies=[
            Dependency(
                predecessor_id="A",
                successor_id="B",
                dep_type=DependencyType.FS,
                lag=timedelta(days=1),
            )
        ],
    )
    a = {t.id: t for t in schedule(project).tasks}["A"]
    assert a.free_float == timedelta(days=1)  # not 0 (the pre-fix proxy value)
    assert a.total_float > a.free_float


# The fix delegates every "is this a working day?" decision to the calendar, so it
# must be correct for *any* working week and *any* holiday/vacation block, not just
# a Mon-Fri weekend. These cases prove that against an independent brute-force
# simulation. (``hours_per_day`` is deliberately excluded: the engine documents it
# as not affecting calculation — floats are whole-working-day, sub-day scheduling
# is a future change — so a "4 hours a day" calendar counts days identically.)
def _advance_working_days(d: date, n: int, cal: Calendar) -> date:
    """The working day ``n`` working days after ``d`` (calendar-driven)."""
    result = d
    remaining = n
    while remaining > 0:
        result += timedelta(days=1)
        if cal.is_working_day(result):
            remaining -= 1
    return result


def _link_project(
    cal: Calendar, dep_type: DependencyType, lag_days: int, start: date, a_snet: date | None = None
) -> Project:
    """A─(dep,lag)─►B with a long parallel pole Z so A is never critical (has float)."""
    return Project(
        id="p",
        name="p",
        start_date=start,
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=3), planned_start=a_snet),
            Task(id="B", name="B", duration=timedelta(days=1)),
            Task(id="Z", name="Z", duration=timedelta(days=40)),
        ],
        dependencies=[
            Dependency(
                predecessor_id="A",
                successor_id="B",
                dep_type=dep_type,
                lag=timedelta(days=lag_days),
            )
        ],
        calendar=cal,
    )


def _brute_force_free_float(
    cal: Calendar, dep_type: DependencyType, lag_days: int, start: date
) -> int:
    """Independent ground truth: the largest number of working days A's start can be
    pushed (via SNET) before the successor's binding early date moves. Uses only
    ``schedule()`` output and the calendar, so it shares no logic with _compute_floats."""

    def binding_early(tasks: dict[str, Task]) -> date:
        b = tasks["B"]
        early = (
            b.early_start if dep_type in (DependencyType.FS, DependencyType.SS) else b.early_finish
        )
        assert early is not None
        return early

    base = {t.id: t for t in schedule(_link_project(cal, dep_type, lag_days, start)).tasks}
    a_es0 = base["A"].early_start
    assert a_es0 is not None
    base_succ = binding_early(base)
    k = 0
    while k < 60:
        snet = _advance_working_days(a_es0, k + 1, cal)
        trial = {
            t.id: t for t in schedule(_link_project(cal, dep_type, lag_days, start, snet)).tasks
        }
        if binding_early(trial) != base_succ:
            return k
        k += 1
    return k


_ROBUST_CALENDARS = [
    # id, calendar, a working start day for that calendar
    ("mon_fri", Calendar(working_days=0b0011111), date(2026, 3, 2)),  # Mon-Fri, start Mon
    ("sun_thu", Calendar(working_days=0b1001111), date(2026, 3, 1)),  # Fri+Sat off, start Sun
    ("four_day_mon_thu", Calendar(working_days=0b0001111), date(2026, 3, 2)),  # Fri-Sun off
    (
        "mon_fri_vacation_week",
        Calendar(
            working_days=0b0011111, exceptions=[DateRange(date(2026, 3, 16), date(2026, 3, 20))]
        ),
        date(2026, 3, 2),  # a whole Mon-Fri work week off two weeks out
    ),
]


@pytest.mark.parametrize(("cal_id", "cal", "start"), _ROBUST_CALENDARS)
@pytest.mark.parametrize("dep_type", DEP_TYPES)
def test_free_float_is_calendar_agnostic(
    cal_id: str, cal: Calendar, start: date, dep_type: DependencyType
) -> None:
    """free_float matches an independent brute-force simulation for alternate
    weekends (Fri+Sat off), short weeks (4-day), and whole-week vacations — every
    non-working span a calendar-day lag can land in, not only the Mon-Fri weekend
    the original proxy happened to be tuned against (#1828)."""
    lag_days = 6  # a calendar-day lag guaranteed to span a non-working stretch
    a = {t.id: t for t in schedule(_link_project(cal, dep_type, lag_days, start)).tasks}["A"]
    expected = _brute_force_free_float(cal, dep_type, lag_days, start)
    assert a.free_float == timedelta(days=expected)


def test_free_float_absorbs_whole_vacation_week() -> None:
    """A whole-week vacation the FS lag lands inside is absorbed into free float: A
    can slip across the entire blocked week without moving B's early start (#1828).

    Mon-Fri calendar with Mon 15-Jun .. Fri 19-Jun off. A(3d) finishes Wed 3-Jun;
    an 11-cd FS lag lands the imposed date on Mon 15-Jun (in the vacation), snapping
    B to Mon 22-Jun. A can slip 5 working days (through Tue 9-Jun) before that snap
    releases and B moves — the vacation week is real free float, reported 0 before."""
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 6, 1),  # Monday
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=3)),
            Task(id="B", name="B", duration=timedelta(days=1)),
            Task(id="Z", name="Z", duration=timedelta(days=40)),  # keep A non-critical
        ],
        dependencies=[
            Dependency(
                predecessor_id="A",
                successor_id="B",
                dep_type=DependencyType.FS,
                lag=timedelta(days=11),
            )
        ],
        calendar=Calendar(
            working_days=0b0011111,
            exceptions=[DateRange(date(2026, 6, 15), date(2026, 6, 19))],
        ),
    )
    result = {t.id: t for t in schedule(project).tasks}
    assert result["B"].early_start == date(2026, 6, 22)
    assert result["A"].free_float == timedelta(days=5)
    assert result["A"].total_float > result["A"].free_float
