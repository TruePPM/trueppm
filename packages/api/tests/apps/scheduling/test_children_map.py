"""Behavior-preservation tests for ``_build_children_map`` (issue #1011).

The WBS-hierarchy children map used by summary expansion was previously built with
a nested scan over ``db_tasks`` (O(N^2)); it is now a single-pass index (O(N)). These
tests pin that the new implementation returns a result *byte-for-byte identical* to
the original O(N^2) algorithm — the reference implementation is reproduced inline so
any future drift fails here rather than in production schedule output.

No DB is touched: ``_build_children_map`` reads only ``.id`` and ``.wbs_path``, so
the tasks are lightweight stand-ins.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from trueppm_api.apps.scheduling.tasks import _build_children_map


def _task(task_id: str, wbs_path: str | None) -> Any:
    return SimpleNamespace(id=task_id, wbs_path=wbs_path)


def _reference_children_map(db_tasks: list[Any]) -> dict[str, list[str]]:
    """The original O(N^2) construction, verbatim, as the equality oracle."""
    children_map: dict[str, list[str]] = {}
    for t in db_tasks:
        if not t.wbs_path:
            continue
        parts = str(t.wbs_path).rsplit(".", 1)
        if len(parts) < 2:
            continue
        parent_path = parts[0]
        for candidate in db_tasks:
            if candidate.wbs_path and str(candidate.wbs_path) == parent_path:
                parent_id = str(candidate.id)
                children_map.setdefault(parent_id, []).append(str(t.id))
                break
    return children_map


def _four_level_wbs() -> list[Any]:
    """~500 tasks across a 4-level WBS (5 × 4 × 4 × 5 = 505), parents before children."""
    tasks: list[Any] = []
    counter = 0

    def _add(wbs: str) -> str:
        nonlocal counter
        tid = f"task-{counter}"
        counter += 1
        tasks.append(_task(tid, wbs))
        return tid

    for a in range(1, 6):  # 5 roots
        _add(f"{a}")
        for b in range(1, 5):  # 4 per root
            _add(f"{a}.{b}")
            for c in range(1, 5):  # 4 per level-2
                _add(f"{a}.{b}.{c}")
                for d in range(1, 6):  # 5 per level-3
                    _add(f"{a}.{b}.{c}.{d}")
    return tasks


def test_matches_reference_on_500_task_four_level_wbs() -> None:
    tasks = _four_level_wbs()
    assert len(tasks) == 505
    assert _build_children_map(tasks) == _reference_children_map(tasks)


def test_empty_input() -> None:
    assert _build_children_map([]) == {}


def test_roots_only_have_no_parents() -> None:
    tasks = [_task("a", "1"), _task("b", "2"), _task("c", "3")]
    assert _build_children_map(tasks) == {}


def test_child_with_missing_parent_is_dropped() -> None:
    # "1.1" exists but no task has wbs_path "1" — the child resolves to no parent
    # and must not appear in any children list (matches the original ``break``-on-
    # no-match behavior, which simply fell through).
    tasks = [_task("orphan", "1.1"), _task("other", "2")]
    result = _build_children_map(tasks)
    assert result == {}
    assert result == _reference_children_map(tasks)


def test_children_preserve_db_tasks_order() -> None:
    tasks = [
        _task("parent", "1"),
        _task("c2", "1.2"),
        _task("c1", "1.1"),
        _task("c3", "1.3"),
    ]
    # Children appended in db_tasks iteration order, not sorted by wbs_path.
    assert _build_children_map(tasks) == {"parent": ["c2", "c1", "c3"]}


def test_duplicate_wbs_path_first_writer_wins_as_parent() -> None:
    # Two tasks share wbs_path "1"; the original loop ``break``s on the first match,
    # so the first task in order owns the children. setdefault must do the same.
    tasks = [
        _task("p_first", "1"),
        _task("p_second", "1"),
        _task("child", "1.1"),
    ]
    result = _build_children_map(tasks)
    assert result == {"p_first": ["child"]}
    assert result == _reference_children_map(tasks)


def test_nested_levels_each_resolve_to_immediate_parent() -> None:
    tasks = [
        _task("L1", "1"),
        _task("L2", "1.1"),
        _task("L3", "1.1.1"),
    ]
    assert _build_children_map(tasks) == {"L1": ["L2"], "L2": ["L3"]}
