"""Unit tests for ``build_sched_graph`` — the shared summary-shaping step (#3527).

``build_sched_tasks`` was introduced (#1185) as the single source of truth for the
API→engine *task* mapping so the CPM and Monte Carlo inputs could not drift. The
converter was shared; the graph shaping that follows it was not, and every Monte
Carlo path skipped it — so phases were simulated as ordinary schedulable work.
``build_sched_graph`` is that shaping step, extracted so a fourth call site cannot
repeat it.

No DB is touched: the function reads only ``.id``/``.wbs_path`` off the Django rows
and otherwise operates on scheduler dataclasses, so the rows are lightweight
stand-ins (same approach as ``test_children_map.py``).
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from trueppm_scheduler.engine import InvalidScheduleInput
from trueppm_scheduler.models import Dependency as SchedDependency
from trueppm_scheduler.models import DependencyType
from trueppm_scheduler.models import Task as SchedTask

from trueppm_api.apps.scheduling.services import build_sched_graph


def _db(task_id: str, wbs_path: str) -> Any:
    return SimpleNamespace(id=task_id, wbs_path=wbs_path)


def _sched(task_id: str, days: int) -> SchedTask:
    return SchedTask(id=task_id, name=task_id, duration=timedelta(days=days))


def _phased() -> tuple[list[Any], list[SchedTask]]:
    """One phase (``1``) over two leaves, plus a standalone downstream task (``2``)."""
    db_tasks = [_db("phase", "1"), _db("leaf_a", "1.1"), _db("leaf_b", "1.2"), _db("next", "2")]
    sched_tasks = [_sched("phase", 60), _sched("leaf_a", 3), _sched("leaf_b", 2), _sched("next", 4)]
    return db_tasks, sched_tasks


def test_the_simulated_task_set_excludes_summary_ids() -> None:
    """The acceptance criterion from the report: no phase reaches the engine."""
    db_tasks, sched_tasks = _phased()

    graph = build_sched_graph(db_tasks, sched_tasks, [])

    assert graph.summary_ids == {"phase"}
    assert [t.id for t in graph.tasks] == ["leaf_a", "leaf_b", "next"]
    assert "phase" not in {t.id for t in graph.tasks}


def test_an_edge_from_a_phase_is_fanned_out_to_its_leaves() -> None:
    """Summaries are *expanded*, not merely dropped.

    Dropping the row without re-homing its edges would leave the successor
    unconstrained and forecast it at the project start — wrong in the opposite
    direction from the phantom, and equally invisible in a date the UI happily renders.
    """
    db_tasks, sched_tasks = _phased()
    deps = [
        SchedDependency(
            predecessor_id="phase",
            successor_id="next",
            dep_type=DependencyType.FS,
            lag=timedelta(days=0),
        )
    ]

    graph = build_sched_graph(db_tasks, sched_tasks, deps)

    assert {(d.predecessor_id, d.successor_id) for d in graph.dependencies} == {
        ("leaf_a", "next"),
        ("leaf_b", "next"),
    }


def test_leaf_db_tasks_mirrors_the_simulated_set() -> None:
    """The Django-row subset used for per-run reporting (`task_count`, the forecast
    diagnostic) must describe what was simulated, not what was loaded."""
    db_tasks, sched_tasks = _phased()

    graph = build_sched_graph(db_tasks, sched_tasks, [])

    assert [t.id for t in graph.leaf_db_tasks] == ["leaf_a", "leaf_b", "next"]
    assert len(graph.leaf_db_tasks) == len(graph.tasks)


def test_a_flat_wbs_project_passes_through_unchanged() -> None:
    """The shape that hid this bug for so long: with no summaries there is nothing to
    strip, and the inputs must survive identically."""
    db_tasks = [_db("a", "1"), _db("b", "2")]
    sched_tasks = [_sched("a", 3), _sched("b", 2)]
    deps = [
        SchedDependency(
            predecessor_id="a", successor_id="b", dep_type=DependencyType.FS, lag=timedelta(days=0)
        )
    ]

    graph = build_sched_graph(db_tasks, sched_tasks, deps)

    assert graph.summary_ids == set()
    assert graph.tasks == sched_tasks
    assert graph.dependencies == deps
    assert graph.leaf_db_tasks == db_tasks


def test_a_phase_under_a_phase_leaves_only_the_real_leaf() -> None:
    """A nested WBS: `1` over `1.1` over `1.1.1`.

    `1.1` is simultaneously a child of one summary and the parent of another. It
    must be treated as a summary (stripped), not kept because it happens to be
    someone's child — `wbs_path` parenthood has no integrity enforcement, so this
    combination is the one a later refactor is most likely to get silently wrong.
    """
    db_tasks = [_db("top", "1"), _db("mid", "1.1"), _db("leaf", "1.1.1")]
    sched_tasks = [_sched("top", 60), _sched("mid", 30), _sched("leaf", 3)]

    graph = build_sched_graph(db_tasks, sched_tasks, [])

    assert graph.summary_ids == {"top", "mid"}
    assert [t.id for t in graph.tasks] == ["leaf"]


def test_a_phase_to_phase_edge_expands_to_the_leaf_cross_product() -> None:
    """The highest-combinatorics case, and the one that can reach MAX_EXPANDED_EDGES."""
    db_tasks = [
        _db("p1", "1"),
        _db("a", "1.1"),
        _db("b", "1.2"),
        _db("p2", "2"),
        _db("c", "2.1"),
        _db("d", "2.2"),
    ]
    sched_tasks = [
        _sched("p1", 60),
        _sched("a", 3),
        _sched("b", 2),
        _sched("p2", 40),
        _sched("c", 4),
        _sched("d", 1),
    ]
    deps = [
        SchedDependency(
            predecessor_id="p1",
            successor_id="p2",
            dep_type=DependencyType.FS,
            lag=timedelta(days=0),
        )
    ]

    graph = build_sched_graph(db_tasks, sched_tasks, deps)

    assert graph.summary_ids == {"p1", "p2"}
    assert {(d.predecessor_id, d.successor_id) for d in graph.dependencies} == {
        ("a", "c"),
        ("a", "d"),
        ("b", "c"),
        ("b", "d"),
    }


def test_the_raw_edge_cap_is_checked_BEFORE_the_per_edge_walk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pins the ordering invariant `build_sched_graph`'s docstring claims (#3527).

    The input below violates two rules at once: it exceeds the raw-edge cap AND it
    carries a Start-to-Start link from a summary, which `expand_summary_dependencies`
    rejects while walking the edge list. Asserting on *which* error comes back is
    what proves the O(1) length check runs first — the whole reason the cap was
    lifted out of the engine's `_validate_project`, which is not reached until
    `schedule()`/`monte_carlo()` is already called.

    `MAX_DEPENDENCIES` is patched on the engine module rather than materializing
    100k edges: `build_sched_graph` imports it at call time, so the patch takes.
    """
    import trueppm_scheduler.engine as engine

    monkeypatch.setattr(engine, "MAX_DEPENDENCIES", 1)

    db_tasks, sched_tasks = _phased()
    deps = [
        SchedDependency(
            predecessor_id="phase",
            successor_id="next",
            dep_type=DependencyType.SS,
            lag=timedelta(days=0),
        ),
        SchedDependency(
            predecessor_id="leaf_a",
            successor_id="next",
            dep_type=DependencyType.FS,
            lag=timedelta(days=0),
        ),
    ]

    with pytest.raises(InvalidScheduleInput) as exc:
        build_sched_graph(db_tasks, sched_tasks, deps)

    assert "exceeding the maximum" in str(exc.value)
    assert "Start-to-Start" not in str(exc.value)
