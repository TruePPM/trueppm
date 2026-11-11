"""The start-of-day cap on zero-lag milestone inheritors stays linear (#4526).

A milestone's start-of-day cap must hold on every milestone that takes its
reading at zero lag, transitively. The first implementation listed every path
through those inheritors, which is exponential in a layered lattice of
milestones (each layer fully linked to the next) and cubic in a plain chain:
anyone with Scheduler rights could stall a recompute with a few dozen
milestones. The cap now reads a per-node summary (``engine._Inheritors``).

The bound is asserted as an operation count, not a wall-clock time, so it is
not flaky: every reading the cap tests goes through ``_start_reading``, and
listing paths called it once per path per step.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta

import pytest

from trueppm_scheduler import Calendar, Dependency, Project, Task, schedule
from trueppm_scheduler.engine import milestones

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


@pytest.mark.parametrize(
    ("build", "size"),
    [(_lattice, 40), (_chain, 1500)],
    ids=["lattice-depth-40", "chain-1500"],
)
def test_inheritor_cap_cost_is_linear_in_the_network(
    monkeypatch: pytest.MonkeyPatch, build: Callable[[int], Project], size: int
) -> None:
    """Readings tested stay within a constant per link.

    Listing paths, a 40-layer lattice has 2**40 of them, and a 1,500-milestone
    chain about a million with the cap's stepping loop walking each one.
    """
    project = build(size)
    calls = 0
    real = milestones._start_reading

    def counting(instant: date, start_display: bool, cal: Calendar) -> bool:
        nonlocal calls
        calls += 1
        return real(instant, start_display, cal)

    monkeypatch.setattr(milestones, "_start_reading", counting)
    result = schedule(project)
    assert result.project_finish is not None
    links = len(project.dependencies) + len(project.tasks)
    assert calls <= 40 * links, (calls, links)
