"""The start-of-day cap on zero-lag milestone inheritors does not enumerate paths (#4526).

A milestone's start-of-day cap must hold on every milestone that takes its
reading at zero lag, transitively. The first implementation listed every path
through those inheritors, which is exponential in a layered lattice of
milestones (each layer fully linked to the next) and cubic in a plain chain:
anyone with Scheduler rights could stall a recompute with a few dozen
milestones. The cap now reads a per-node summary (``engine._Inheritors``).

The real bound is not linear. Building the summaries is ``O((V + E) * C)`` per
pass, ``C`` the distinct calendars among the inheritors, because each node keeps
one entry per calendar reached through it; each step of a cap then costs
``O(C)``. With a fixed set of calendars that is linear in the network, but a
chain giving every milestone its own calendar has ``C = V`` and is quadratic
(about 0.12 s at 1,000 milestones and 1 s at 3,000, measured in review). The
tests below pin both halves: linear when ``C`` is fixed, and within a constant
multiple of ``(V + E) * C`` when it is not.

The bounds are asserted as operation counts, not wall-clock times, so they are
not flaky: every reading the cap tests goes through ``_start_reading`` (listing
paths called it once per path per step), and every per-calendar summary entry a
node builds goes through ``_offer_switch``.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta

import pytest

from trueppm_scheduler import Calendar, Dependency, Project, Task, schedule
from trueppm_scheduler.engine import milestones
from trueppm_scheduler.models import DateRange

_FIVE = Calendar(working_days=0b0011111)
_FOUR = Calendar(working_days=0b0001111)


def _lattice(depth: int) -> Project:
    """``W`` into ``depth`` layers of two zero-lag FS milestones, each layer linked
    to every milestone of the next, one of each pair on a Monday-to-Thursday week."""
    tasks = [Task(id="W", name="W", duration=timedelta(days=3))]
    deps: list[Dependency] = []
    prev = ["W"]
    for i in range(depth):
        cur = [f"A{i}", f"B{i}"]
        tasks.append(Task(id=cur[0], name=cur[0], duration=timedelta(0)))
        tasks.append(Task(id=cur[1], name=cur[1], duration=timedelta(0), calendar_id="four"))
        deps += [Dependency(p, c) for p in prev for c in cur]
        prev = cur
    return Project(
        id="p",
        name="p",
        start_date=date(2027, 3, 1),
        calendar=_FIVE,
        calendars={"four": _FOUR},
        tasks=tasks,
        dependencies=deps,
    )


def _chain(length: int) -> Project:
    """``W`` into a chain of zero-lag FS milestones alternating two calendars."""
    tasks = [Task(id="W", name="W", duration=timedelta(days=3))]
    deps: list[Dependency] = []
    prev = "W"
    for i in range(length):
        tid = f"M{i}"
        tasks.append(
            Task(id=tid, name=tid, duration=timedelta(0), calendar_id="four" if i % 2 else None)
        )
        deps.append(Dependency(prev, tid))
        prev = tid
    return Project(
        id="p",
        name="p",
        start_date=date(2027, 3, 1),
        calendar=_FIVE,
        calendars={"four": _FOUR},
        tasks=tasks,
        dependencies=deps,
    )


def _distinct_calendar_chain(length: int) -> Project:
    """``W`` into a chain of zero-lag FS milestones, each on a calendar of its own.

    Every calendar is the Monday-to-Friday week with a holiday on a different
    far-off day, so each is a distinct object and ``C`` equals the chain length.
    """
    tasks = [Task(id="W", name="W", duration=timedelta(days=3))]
    deps: list[Dependency] = []
    calendars: dict[str, Calendar] = {}
    prev = "W"
    for i in range(length):
        tid = f"M{i}"
        day = date(2030, 1, 1) + timedelta(days=i)
        calendars[f"c{i}"] = Calendar(working_days=0b0011111, exceptions=(DateRange(day, day),))
        tasks.append(Task(id=tid, name=tid, duration=timedelta(0), calendar_id=f"c{i}"))
        deps.append(Dependency(prev, tid))
        prev = tid
    return Project(
        id="p",
        name="p",
        start_date=date(2027, 3, 1),
        calendar=_FIVE,
        calendars=calendars,
        tasks=tasks,
        dependencies=deps,
    )


def _count_cap_work(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Count ``_start_reading`` and ``_offer_switch`` calls without changing them."""
    counts = {"readings": 0, "offers": 0}
    real_reading = milestones._start_reading
    real_offer = milestones._offer_switch

    def counting_reading(instant: date, start_display: bool, cal: Calendar) -> bool:
        counts["readings"] += 1
        return real_reading(instant, start_display, cal)

    def counting_offer(switches: dict[int, tuple[Calendar, date]], c: Calendar, m: date) -> None:
        counts["offers"] += 1
        real_offer(switches, c, m)

    monkeypatch.setattr(milestones, "_start_reading", counting_reading)
    monkeypatch.setattr(milestones, "_offer_switch", counting_offer)
    return counts


@pytest.mark.parametrize(
    ("build", "size"),
    [(_lattice, 40), (_chain, 1500)],
    ids=["lattice-depth-40", "chain-1500"],
)
def test_inheritor_cap_cost_is_linear_with_a_fixed_set_of_calendars(
    monkeypatch: pytest.MonkeyPatch, build: Callable[[int], Project], size: int
) -> None:
    """With two calendars, readings tested and summary entries built stay within a
    constant per link.

    Listing paths, a 40-layer lattice has 2**40 of them, and a 1,500-milestone
    chain about a million with the cap's stepping loop walking each one. A
    summary that grew with the chain instead of with ``C`` would show up in
    ``offers``.
    """
    project = build(size)
    counts = _count_cap_work(monkeypatch)
    result = schedule(project)
    assert result.project_finish is not None
    links = len(project.dependencies) + len(project.tasks)
    assert counts["readings"] <= 40 * links, (counts, links)
    assert counts["offers"] <= 8 * links, (counts, links)


def test_inheritor_cap_cost_is_bounded_by_links_times_calendars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a calendar per milestone, the work stays within ``(V + E) * C``.

    This is the shape that makes the summary quadratic (``C = V``), so the bound
    is quadratic too, stated as such: it would fail on a cubic builder (a node
    re-walking its whole subtree per calendar, or the path enumeration this
    replaced), not on the quadratic cost the summary genuinely has. The lower
    bound on ``offers`` keeps the test honest: it proves the shape really does
    carry ``C`` entries per node, so the upper bound is not met vacuously.
    """
    length = 1000
    project = _distinct_calendar_chain(length)
    counts = _count_cap_work(monkeypatch)
    result = schedule(project)
    assert result.project_finish is not None
    links = len(project.dependencies) + len(project.tasks)
    calendars = len(project.calendars) + 1
    budget = links * calendars
    assert counts["offers"] >= length * length // 4, (counts, budget)
    assert counts["offers"] <= 2 * budget, (counts, budget)
    assert counts["readings"] <= 4 * budget, (counts, budget)
