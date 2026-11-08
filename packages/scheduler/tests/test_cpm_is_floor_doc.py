"""The CPM finish is the floor of the Monte Carlo distribution, not its median (#4700).

Samples are clamped up to ``Task.duration`` (#3765), so on a network of FS/SS
links no run finishes before CPM and P(finish <= CPM) falls toward 0 as more
tasks carry an estimate. The docs once called the CPM date "a coin flip" near
P50. This pins the claim on a synthetic 200-task estimated FS chain and a staggered SS+2 chain and
keeps the stale wording out of every site that was corrected.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

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

STALE_PHRASES = ("coin flip", "close to the CPM finish", "close to P50", "even odds")

_SCHEDULER_SITES = (
    "README.md",
    "src/trueppm_scheduler/engine.py",
    "src/trueppm_scheduler/cli.py",
    "notebooks/02-monte-carlo.ipynb",
)
_WEBSITE_SITES = (
    "features/scheduler.md",
    "features/monte-carlo.md",
    "features/schedule/index.md",
    "guides/project-managers.md",
    "overview/index.md",
)


def _scheduler_root() -> Path | None:
    """The scheduler package root, found by walking ancestors (mutmut copies, #4880)."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "README.md").is_file() and (parent / "src/trueppm_scheduler").is_dir():
            return parent
    return None


def _website_docs() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "website/src/content/docs"
        if candidate.is_dir():
            return candidate
    return None


def _estimated_chain(n: int, dep_type: DependencyType) -> Project:
    """``n`` estimated tasks chained by ``dep_type``; SS links carry a 2-day lag so they stagger."""
    lag = timedelta(days=2) if dep_type is DependencyType.SS else timedelta(0)
    tasks = [
        Task(
            id=f"t{i}",
            name=f"Task {i}",
            duration=timedelta(days=3),
            optimistic_duration=timedelta(days=2),
            most_likely_duration=timedelta(days=3),
            pessimistic_duration=timedelta(days=6),
        )
        for i in range(n)
    ]
    deps = [
        Dependency(predecessor_id=f"t{i - 1}", successor_id=f"t{i}", dep_type=dep_type, lag=lag)
        for i in range(1, n)
    ]
    return Project(
        id="cpm-floor",
        name="CPM floor",
        start_date=date(2026, 1, 5),
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=31, hours_per_day=8.0, timezone="UTC"),
    )


@pytest.mark.parametrize("dep_type", [DependencyType.FS, DependencyType.SS])
def test_cpm_finish_is_the_floor_of_the_distribution(dep_type: DependencyType) -> None:
    project = _estimated_chain(200, dep_type)
    cpm = schedule(project)
    mc = monte_carlo(project, runs=5_000, seed=4700)
    assert mc.distribution[0] >= cpm.project_finish
    at_or_before = sum(1 for d in mc.distribution if d <= cpm.project_finish)
    assert at_or_before / len(mc.distribution) < 0.5
    assert mc.p50 > cpm.project_finish


def _assert_clean(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    for phrase in STALE_PHRASES:
        assert phrase not in text, f"stale phrase {phrase!r} is back in {path.name}"


def test_scheduler_sources_do_not_call_cpm_a_coin_flip() -> None:
    root = _scheduler_root()
    assert root is not None, "scheduler package root not found from any ancestor"
    for rel in _SCHEDULER_SITES:
        _assert_clean(root / rel)


def test_website_pages_do_not_call_cpm_a_coin_flip() -> None:
    docs = _website_docs()
    if docs is None:
        pytest.skip("website docs tree is not present (standalone scheduler package)")
    for rel in _WEBSITE_SITES:
        _assert_clean(docs / rel)
