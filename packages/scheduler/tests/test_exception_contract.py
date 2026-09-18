"""Permanent single-field-mutation contract sweep for the direct-object API (#3846).

The README's "Errors and input limits" section used to claim, unconditionally,
that every exception the engine raises subclasses ``ValueError`` (via
``SchedulerError``). That held for the ``from_dict``/``from_json`` ingestion path
(#826/#1207), but not for the **direct-object API** — constructing
``Project``/``Task``/``Dependency`` in Python, the way every README example does.

The 2026-09-16 pre-release audit measured this by single-field mutation: one field
of ``Task``/``Project``/``Dependency`` changed at a time, over every init field x a
12-value adversarial vector x both public entry points (``schedule()``,
``monte_carlo()``), catching ``SchedulerError`` and recording anything else. That
swept 31 distinct ``(field, entry point, exception)`` leaks across 13 fields, none a
``SchedulerError``. This module makes that sweep a permanent regression test rather
than a one-off finding: ``_validate_project`` was hardened (see ``engine.py``,
``#3846``) to close every leak this sweep found, and the sweep itself stays here so
a future field addition or refactor that reopens one of these gaps fails a test
instead of shipping silently.

``Task.id`` is excluded from the Task sweep: ``Task.id=None``/``[]`` surfaces
``TypeError: None cannot be a node`` from networkx and is tracked separately under
**#2463** (0.5, ``release::stretch``) — a deliberate scope boundary, not an
oversight. Fixing it here would silently absorb #2463's scope into this issue.
"""

from __future__ import annotations

import dataclasses
import math
from datetime import date, timedelta
from typing import Any

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    Project,
    SchedulerError,
    Task,
    monte_carlo,
    schedule,
)

# The 12-value adversarial vector from the audit repro: every value is tried
# against every field regardless of that field's declared type, because the whole
# point is that a direct-object caller is not type-checked by the dataclass itself.
_ADVERSARIAL_VALUES: tuple[Any, ...] = (
    None,
    "x",
    -1,
    0,
    1.5,
    [],
    {},
    math.nan,
    math.inf,
    True,
    timedelta(days=-1),
    object(),
)

_TASK_FIELDS = [
    f.name
    for f in dataclasses.fields(Task)
    if f.init and f.name != "id"  # Task.id: tracked separately under #2463.
]
_PROJECT_FIELDS = [f.name for f in dataclasses.fields(Project) if f.init]
_DEPENDENCY_FIELDS = [f.name for f in dataclasses.fields(Dependency) if f.init]


def _base_project() -> Project:
    """A minimal, valid two-task/one-dependency project to mutate one field of."""
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 1),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=1)),
            Task(id="B", name="B", duration=timedelta(days=1)),
        ],
        dependencies=[Dependency(predecessor_id="A", successor_id="B")],
        calendar=Calendar(),
    )


def _assert_only_scheduler_error(label: str, project: Project) -> None:
    """Both public entry points must return or raise only a SchedulerError.

    ``SchedulerError`` subclasses ``ValueError``, matching the README's documented
    contract; any *other* escaping exception (AttributeError, a bare TypeError,
    OverflowError, ...) is exactly the contract violation this issue exists to
    close.
    """

    def _monte_carlo() -> object:
        return monte_carlo(project, runs=5, seed=1, max_runs=None, max_tasks=None)

    for entry_point, call in (
        ("schedule", lambda: schedule(project)),
        ("monte_carlo", _monte_carlo),
    ):
        try:
            call()
        except SchedulerError:
            continue
        except Exception as exc:  # classifying the escape IS the test
            raise AssertionError(
                f"{label} via {entry_point}(): non-conforming escape {type(exc).__name__}: {exc}"
            ) from exc


@pytest.mark.parametrize("value", _ADVERSARIAL_VALUES)
@pytest.mark.parametrize("field", _PROJECT_FIELDS)
def test_project_field_mutation_conforms(field: str, value: Any) -> None:
    """Mutating any single Project field to an adversarial value must raise only
    a SchedulerError from schedule()/monte_carlo() (#3846)."""
    project = dataclasses.replace(_base_project(), **{field: value})
    _assert_only_scheduler_error(f"Project.{field}={value!r}", project)


@pytest.mark.parametrize("value", _ADVERSARIAL_VALUES)
@pytest.mark.parametrize("field", _TASK_FIELDS)
def test_task_field_mutation_conforms(field: str, value: Any) -> None:
    """Mutating any single Task field (except id, see #2463) to an adversarial
    value must raise only a SchedulerError (#3846)."""
    project = _base_project()
    mutated = dataclasses.replace(project.tasks[0], **{field: value})
    project.tasks = [mutated, project.tasks[1]]
    _assert_only_scheduler_error(f"Task.{field}={value!r}", project)


@pytest.mark.parametrize("value", _ADVERSARIAL_VALUES)
@pytest.mark.parametrize("field", _DEPENDENCY_FIELDS)
def test_dependency_field_mutation_conforms(field: str, value: Any) -> None:
    """Mutating any single Dependency field to an adversarial value must raise
    only a SchedulerError (#3846)."""
    project = _base_project()
    mutated = dataclasses.replace(project.dependencies[0], **{field: value})
    project.dependencies = [mutated]
    _assert_only_scheduler_error(f"Dependency.{field}={value!r}", project)
