"""Red-team regression tests (#2460, #2461, #2462).

Covers the findings from the 2026-07-27 scheduler red-team, which differential-tested
``schedule()`` against ``monte_carlo()`` on the deterministic-equality contract stated
in ``monte_carlo()``'s docstring — *"a fully deterministic project (no estimates, no
velocity signal) simulates to precisely the CPM finish date"*:

* #2460 — a completed task with ``actual_finish`` but no ``actual_start`` had its
  Monte Carlo start pinned exactly one working day back regardless of duration,
  mis-anchoring every SS/SF successor by ``duration - 1`` working days.
* #2461 — a completed task whose actual falls on a non-working day had its
  successors anchored off the *snapped* working day, while ``schedule()`` anchors
  off the verbatim date (ADR-0136 "actuals are truth"). The residual of #1929,
  which fixed only the terminal date conversion.
* #2462 — ``Calendar``'s cached exception index went stale on a same-length
  in-place mutation, so ``is_working_day`` kept answering from the pre-edit index.
"""

from __future__ import annotations

import dataclasses
import random
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.models import DateRange

# 2026-03-02 is a Monday; 03-07/03-08 are Sat/Sun.
START = date(2026, 3, 2)
WEEKDAYS = 0b0011111


def _project(tasks: list[Task], deps: list[Dependency], **kw: object) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=WEEKDAYS),
        **kw,  # type: ignore[arg-type]
    )


def _assert_mc_matches_cpm(project: Project) -> date:
    """The deterministic-equality contract: every percentile equals the CPM finish."""
    cpm = schedule(project).project_finish
    mc = monte_carlo(project, runs=64, seed=3)
    assert mc.p50 == mc.p80 == mc.p95 == cpm, (
        f"CPM finish {cpm} vs MC p50/p80/p95 {mc.p50}/{mc.p80}/{mc.p95}"
    )
    return cpm


# ---------------------------------------------------------------------------
# #2460 — completed start pin must be a FULL duration back, not one day
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("duration_days", [1, 2, 3, 5, 8])
def test_completed_without_actual_start_lays_full_duration_back(duration_days: int) -> None:
    """MC must pin the start where schedule() puts it: a full duration back (#2460).

    The API deliberately leaves ``actual_start`` null on a straight-to-COMPLETE
    transition (ADR-0136), so this is the ordinary shape of a completed task, not a
    corner case. An SS successor is what makes the mis-anchored start observable —
    it anchors on the predecessor's *start*.
    """
    project = _project(
        [
            Task(
                id="A",
                name="A",
                duration=timedelta(days=duration_days),
                actual_finish=date(2026, 3, 20),  # Friday
            ),
            Task(id="B", name="B", duration=timedelta(days=0)),
        ],
        [Dependency("A", "B", DependencyType.SS, timedelta(days=1))],
    )
    _assert_mc_matches_cpm(project)


def test_completed_start_pin_matches_schedule_early_start() -> None:
    """The pinned start is schedule()'s ``early_start``, not one day before the finish."""
    project = _project(
        [Task(id="A", name="A", duration=timedelta(days=5), actual_finish=date(2026, 3, 20))],
        [],
    )
    task = schedule(project).tasks[0]
    # Mon 3/16..Fri 3/20 is the full 5-working-day span back from the recorded finish.
    assert task.early_start == date(2026, 3, 16)
    assert task.early_finish == date(2026, 3, 20)
    _assert_mc_matches_cpm(project)


# ---------------------------------------------------------------------------
# #2461 — non-working actuals must anchor successors off the VERBATIM date
# ---------------------------------------------------------------------------


def test_weekend_actual_finish_with_fs_lag_anchors_off_verbatim_date() -> None:
    """FS + non-zero lag off a Saturday finish (#2461).

    ``schedule()`` computes ``next_working_day(Sat 3/7 + 1 + 2d) == Tue 3/10``. The
    old offset path read the Saturday as the preceding Friday and produced Mon 3/9.
    Zero lag happens to agree, which is why #1929 looked complete.
    """
    project = _project(
        [
            Task(id="A", name="A", duration=timedelta(days=0), actual_finish=date(2026, 3, 7)),
            Task(id="B", name="B", duration=timedelta(days=0)),
        ],
        [Dependency("A", "B", DependencyType.FS, timedelta(days=2))],
    )
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 10)


def test_weekend_actual_finish_with_ss_successor() -> None:
    """SS off a Sunday finish (#2461) — and the project must not finish on a Sunday.

    The old ``completed_finish_override`` map was keyed by rounded exclusive-EF
    offset, so the live successor's own offset collided with the completed task's
    key and the project finish was reported as Sun 3/8.
    """
    project = _project(
        [
            Task(id="A", name="A", duration=timedelta(days=0), actual_finish=date(2026, 3, 8)),
            Task(id="B", name="B", duration=timedelta(days=0)),
        ],
        [Dependency("A", "B", DependencyType.SS, timedelta(0))],
    )
    finish = _assert_mc_matches_cpm(project)
    assert finish == date(2026, 3, 9)  # Monday — not the Sunday actual


def test_weekend_actual_start_only_keeps_verbatim_finish() -> None:
    """100% complete with only a weekend ``actual_start`` recorded (#2461)."""
    project = _project(
        [
            Task(
                id="A",
                name="A",
                duration=timedelta(days=0),
                percent_complete=100.0,
                actual_start=date(2026, 3, 7),  # Saturday
            )
        ],
        [],
    )
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 7)


def test_weekend_actual_finish_is_not_attributed_to_a_live_task() -> None:
    """A live task finishing later must report its own date, not a completed weekend pin."""
    project = _project(
        [
            Task(
                id="A",
                name="A",
                duration=timedelta(days=5),
                actual_start=date(2026, 3, 2),
                actual_finish=date(2026, 3, 7),
            ),  # Saturday
            Task(id="B", name="B", duration=timedelta(days=10)),
        ],
        [],
    )
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 13)


@pytest.mark.parametrize("dep_type", list(DependencyType))
def test_every_dep_type_off_a_weekend_completed_predecessor(dep_type: DependencyType) -> None:
    """All four dependency types must agree across the two passes (#2461)."""
    project = _project(
        [
            Task(id="A", name="A", duration=timedelta(days=3), actual_finish=date(2026, 3, 7)),
            Task(id="B", name="B", duration=timedelta(days=2)),
        ],
        [Dependency("A", "B", dep_type, timedelta(days=2))],
    )
    _assert_mc_matches_cpm(project)


# ---------------------------------------------------------------------------
# #2460/#2461 — the contract itself, fuzzed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(25))
def test_deterministic_projects_with_actuals_simulate_to_the_cpm_finish(seed: int) -> None:
    """Fuzz the deterministic-equality contract over projects carrying actuals.

    This is the harness that found #2460 and #2461: no three-point estimates and no
    velocity signal, so every run is identical and ``monte_carlo()`` must land
    exactly on ``schedule().project_finish``. Actuals are drawn on *any* weekday
    including weekends, which is what exercises the verbatim-date paths.

    Scope note before widening this generator: it only ever stamps ``actual_start``
    on tasks it has already marked 100% complete, and the strict equality below
    depends on that. An *in-progress* task with a non-working ``actual_start`` is
    the one case Monte Carlo cannot reproduce exactly — the working-day offset
    index has no offset for the date, so the floor snaps forward and the finish
    can land up to one working day late, deliberately (see ``_mc_es_floors``,
    #2833). Draw that here and the assertion must relax to ``>=``, which is the
    property ``test_contract_fuzz.test_monte_carlo_never_precedes_cpm`` already
    covers over exactly that space.
    """
    rng = random.Random(seed)
    n = rng.randint(2, 6)
    tasks: list[Task] = []
    for i in range(n):
        t = Task(id=f"T{i}", name=f"T{i}", duration=timedelta(days=rng.randint(0, 6)))
        roll = rng.random()
        if roll < 0.35:
            t.percent_complete = 100.0
            finish = START + timedelta(days=rng.randint(0, 15))
            t.actual_finish = finish
            if rng.random() < 0.5:
                t.actual_start = finish - timedelta(days=rng.randint(0, 5))
        elif roll < 0.45:
            # Complete by percent alone, with BOTH actuals null (#2572). The
            # generator used to cap the no-actuals branch at 99, so the third
            # completed-task branch — the one schedule() runs through network
            # logic rather than pinning — was never generated and the harness
            # could not see Monte Carlo dropping its SNET floor and predecessor
            # constraints. Combined with the planned_start roll below, this is
            # what makes the differential assertion cover that branch.
            t.percent_complete = 100.0
        elif roll < 0.6:
            t.percent_complete = float(rng.choice([10, 25, 50, 75, 99]))
        if rng.random() < 0.2:
            t.planned_start = START + timedelta(days=rng.randint(0, 20))
        tasks.append(t)

    deps: list[Dependency] = []
    seen: set[tuple[int, int]] = set()
    for _ in range(rng.randint(1, n)):
        i, j = rng.randrange(n), rng.randrange(n)
        if i >= j or (i, j) in seen:
            continue
        seen.add((i, j))
        deps.append(
            Dependency(
                f"T{i}",
                f"T{j}",
                rng.choice(list(DependencyType)),
                timedelta(days=rng.randint(-2, 4)),
            )
        )
    _assert_mc_matches_cpm(_project(tasks, deps))


# ---------------------------------------------------------------------------
# #2462 — the calendar exception index cannot go stale
# ---------------------------------------------------------------------------


def test_same_length_replacement_is_not_expressible() -> None:
    """The mutation that silently served a stale index must now raise (#2462)."""
    d1, d2 = date(2026, 3, 4), date(2026, 3, 5)
    cal = Calendar(exceptions=[DateRange(d1, d1)])
    assert cal.is_working_day(d1) is False  # builds and caches the index

    with pytest.raises((AttributeError, TypeError)):
        cal.exceptions[0] = DateRange(d2, d2)  # type: ignore[index]
    with pytest.raises(AttributeError):
        cal.exceptions.append(DateRange(d2, d2))  # type: ignore[attr-defined]
    with pytest.raises(dataclasses.FrozenInstanceError):
        cal.exceptions[0].start = d2  # type: ignore[misc]

    # The stale-cache scenario cannot be reached, so the answer is still correct.
    assert cal.is_working_day(d1) is False
    assert cal.is_working_day(d2) is True


def test_reassigning_exceptions_invalidates_the_cache() -> None:
    """Assignment is the supported way to change the set, and must invalidate (#2462)."""
    d1, d2 = date(2026, 3, 4), date(2026, 3, 5)
    cal = Calendar(exceptions=[DateRange(d1, d1)])
    assert cal.is_working_day(d1) is False
    cal.exceptions = [DateRange(d2, d2)]
    assert cal.is_working_day(d1) is True
    assert cal.is_working_day(d2) is False


def test_reassigned_exceptions_are_normalized_to_a_tuple() -> None:
    """Reassignment must normalize too, or the next in-place edit is stale again (#2462)."""
    cal = Calendar(exceptions=[DateRange(date(2026, 3, 4), date(2026, 3, 4))])
    cal.exceptions = [DateRange(date(2026, 3, 5), date(2026, 3, 5))]
    assert isinstance(cal.exceptions, tuple)


def test_schedule_matches_a_freshly_built_calendar_after_reassignment() -> None:
    """End-to-end: a mutated calendar must schedule like an equivalent fresh one (#2462)."""
    holiday = DateRange(date(2026, 3, 10), date(2026, 3, 10))

    def _build(cal: Calendar) -> Project:
        return Project(
            id="p",
            name="p",
            start_date=START,
            tasks=[Task(id="A", name="A", duration=timedelta(days=3))],
            dependencies=[],
            calendar=cal,
        )

    mutated = Calendar(exceptions=[DateRange(date(2026, 3, 4), date(2026, 3, 4))])
    schedule(_build(mutated))  # warm the cached index against the original set
    mutated.exceptions = [holiday]

    assert (
        schedule(_build(mutated)).project_finish
        == schedule(_build(Calendar(exceptions=[holiday]))).project_finish
    )
