"""The CPM finish is the floor of the Monte Carlo distribution, not its median (#4700).

Samples are clamped up to ``Task.duration`` (#3765), so on a network of FS/SS
links no run finishes before CPM and P(finish <= CPM) falls toward 0 as more
tasks carry an estimate. The README once called the CPM date "a coin flip" near
P50. This pins the claim on a 200-task estimated FS chain and keeps the stale
wording out of the docs.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

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


def _find_readme() -> Path | None:
    """README found by walking ancestors (mutmut copies tests under ``mutants/``, #4880)."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "README.md"
        if candidate.is_file() and "trueppm-scheduler" in candidate.read_text(encoding="utf-8"):
            return candidate
    return None


def _estimated_fs_chain(n: int) -> Project:
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
        Dependency(predecessor_id=f"t{i - 1}", successor_id=f"t{i}", dep_type=DependencyType.FS)
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


def test_cpm_finish_is_the_floor_of_the_distribution() -> None:
    project = _estimated_fs_chain(200)
    cpm = schedule(project)
    mc = monte_carlo(project, runs=5_000, seed=4700)
    assert mc.distribution[0] >= cpm.project_finish
    at_or_before = sum(1 for d in mc.distribution if d <= cpm.project_finish)
    assert at_or_before / len(mc.distribution) < 0.5
    assert mc.p50 > cpm.project_finish


def test_readme_does_not_call_cpm_a_coin_flip() -> None:
    readme = _find_readme()
    assert readme is not None, "scheduler README not found from any ancestor"
    text = readme.read_text(encoding="utf-8")
    for phrase in STALE_PHRASES:
        assert phrase not in text, f"stale phrase {phrase!r} is back in the README"
