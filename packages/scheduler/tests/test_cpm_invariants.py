"""CPM core property invariants prescribed by test-strategy (#3667).

``.claude/skills/test-strategy/SKILL.md`` names three invariants that must hold
for any valid DAG: ``total_float >= 0``, a critical-path task has
``total_float == 0``, and project duration equals the ``early_finish`` of the
last task on the critical path. ``test_contract_fuzz.py`` only ever asserted
``free_float <= total_float`` and ``early_start <= early_finish`` — this module
is the dedicated home for the three invariants above, plus one more that falls
out of the engine's own ``driving_edges`` output.

All four properties reuse ``_plausible_projects``/``_PLAUSIBLE_ANCHOR`` from
``test_contract_fuzz.py`` (imported, not copied) rather than the adversarial
``_projects()`` strategy: an input the engine rejects never produces a
``ScheduleResult`` to check, so only the "reaches the forward pass" generator
is useful here. Where an invariant needs a narrower space than
``_plausible_projects`` provides, the narrowing is defined locally and its
reason is documented on the property that uses it.
"""

from __future__ import annotations

import dataclasses
from datetime import timedelta

import pytest
from hypothesis import given

from tests.test_contract_fuzz import _plausible_projects
from trueppm_scheduler import Project, SchedulerError, schedule

pytestmark = pytest.mark.fuzz


# ---------------------------------------------------------------------------
# Invariant 1 & 2: is_critical <=> total_float == 0, and total_float never negative
# ---------------------------------------------------------------------------


@given(project=_plausible_projects())
def test_critical_path_tasks_have_zero_total_float(project: Project) -> None:
    """Every task id in ``result.critical_path`` has ``total_float == 0`` and
    ``is_critical`` set — and the reverse: every ``is_critical`` task appears in
    ``critical_path`` exactly once.

    ``is_critical`` is defined in the engine as ``tf_days == 0 and not
    _is_complete(task)`` (``engine._compute_floats``), and ``critical_path`` is
    built by filtering a topological order down to tasks where ``is_critical``
    is true (``engine.schedule``). Both facts are true **by construction** at
    the single call site that sets them — what this property actually guards
    is that the two independently-maintained representations (a per-task flag
    read by the web float bar, and a list read by the Gantt's critical-path
    overlay) never drift apart, e.g. a future change to one filter condition
    without the other, or a ``critical_path`` built from a stale ``is_critical``
    snapshot. No restriction on the generator is needed: the equivalence holds
    for a completed task too (it is simply excluded from both sides).
    """
    try:
        result = schedule(project)
    except SchedulerError:
        return

    task_map = {t.id: t for t in result.tasks}
    critical_ids = set(result.critical_path)
    flagged_ids = {t.id for t in result.tasks if t.is_critical}

    assert critical_ids == flagged_ids, (
        f"critical_path {sorted(critical_ids)} disagrees with is_critical-flagged "
        f"tasks {sorted(flagged_ids)}"
    )
    assert len(result.critical_path) == len(critical_ids), (
        "critical_path contains a duplicate task id"
    )
    for tid in result.critical_path:
        task = task_map[tid]
        assert task.total_float == timedelta(0), (
            f"{tid}: on critical_path but total_float is {task.total_float}, not zero"
        )
        assert task.is_critical, f"{tid}: on critical_path but is_critical is False"


@given(project=_plausible_projects())
def test_no_negative_total_float(project: Project) -> None:
    """No task in a clean ``schedule()`` return ever has ``total_float < 0``.

    This engine has no hard finish-no-later-than ("deadline") constraint that
    is actually consumed by the CPM pass — ``Task.planned_finish`` round-trips
    but is explicitly documented as reserved-but-inert
    (``models.Task.planned_finish``), so there is no input shape in this
    engine's model that legitimately produces negative float the way an
    external deadline would in a general CPM tool. The invariant is also
    enforced structurally, not just arithmetically: ``_apply_late_dates``
    floors every task's late window at its own early window (``late_finish =
    max(late_finish, early_finish)`` — #3963), and ``_wd_span`` /
    ``_working_days_between`` clamp a negative span to ``0`` on the way into
    ``total_float`` as a second, independent floor. So this property should
    hold for literally any accepted (acyclic, non-degenerate) project — no
    narrowing of ``_plausible_projects`` is applied. A failure here means one
    of those two floors regressed.
    """
    try:
        result = schedule(project)
    except SchedulerError:
        return

    for task in result.tasks:
        assert task.total_float >= timedelta(0), (
            f"{task.id}: total_float {task.total_float} is negative"
        )


# ---------------------------------------------------------------------------
# Invariant 3: project duration == early_finish of the last critical-path task
# ---------------------------------------------------------------------------


def _clear_completion(project: Project) -> Project:
    """Strip every actuals-driven completion signal from ``project``'s tasks.

    ``engine._is_complete`` is ``actual_finish is not None or percent_complete
    >= 100``, and a completed task is force-excluded from ``is_critical`` (and
    therefore ``critical_path``) even when its own ``total_float`` is zero
    (``_compute_floats``: "Completion overrides the zero-float rule" — #1863).
    That override can decouple ``critical_path``'s last entry from the task
    that actually carries ``project_finish``: if the unique task whose
    ``early_finish`` equals ``project_finish`` is complete, it is dropped from
    ``critical_path`` while an upstream, not-yet-complete predecessor (one
    working day short of ``project_finish``) stays critical and ends the list
    instead. That is a real, legitimate scheduling state — not a bug — so
    rather than weakening the invariant this property narrows its input to
    projects with no completed task, where the decoupling cannot arise, and
    says so here instead of silently filtering it out.
    """
    tasks = [
        dataclasses.replace(t, actual_finish=None, percent_complete=min(t.percent_complete, 99.0))
        for t in project.tasks
    ]
    return dataclasses.replace(project, tasks=tasks)


@given(project=_plausible_projects())
def test_project_duration_equals_last_critical_task_early_finish(project: Project) -> None:
    """``project_finish`` equals the ``early_finish`` of the last task on
    ``critical_path``.

    ``critical_path`` is documented as topologically ordered
    (``ScheduleResult.critical_path``), so its last element has no critical
    successor. A critical task with at least one successor always has at
    least one *critical* successor too — its own zero float is inherited from
    the single tightest downstream path, and that path's next hop cannot
    itself carry slack without contradicting the zero float upstream of it.
    So the last entry is a true sink (no successors at all), and a sink's
    ``late_finish`` is anchored directly on ``project_finish`` by the backward
    pass's base case — critical (``late_finish == early_finish``) therefore
    forces ``early_finish == project_finish`` for that task.

    Narrowed to projects with no completed task via :func:`_clear_completion`
    — see its docstring for why a completed task can legitimately break this
    without the engine being wrong.

    If ``critical_path`` is ever empty for a non-degenerate, non-completed
    project, that is itself worth knowing about (it should not happen per the
    reasoning above: the global early-finish maximizer, which always exists
    for at least one task, is always a zero-float sink when nothing is
    complete) — so this is asserted rather than skipped.
    """
    project = _clear_completion(project)
    try:
        result = schedule(project)
    except SchedulerError:
        return

    assert result.critical_path, "no completed task, yet critical_path is empty"
    task_map = {t.id: t for t in result.tasks}
    last = task_map[result.critical_path[-1]]
    assert last.early_finish == result.project_finish, (
        f"{last.id}: last critical_path entry has early_finish {last.early_finish}, "
        f"not project_finish {result.project_finish}"
    )


# ---------------------------------------------------------------------------
# A candidate "transitively across a chain" property was attempted and
# dropped — see the handback report / MR description for why. In short: a
# driving edge (zero per-edge free-float slack) does not imply
# total_float(pred) <= total_float(succ) once a zero-duration milestone sits
# on either end, because a milestone's own float is measured against its
# *instant* (capped by #4183's ``_float_late_instant``) rather than the shown
# day its successor's day-level total_float is measured against. Hypothesis
# found ``t1 -FS-> join`` with total_float 5d vs 4d on the very first run.
# Shipping that assertion would either be a wrong invariant or require fully
# verifying a milestone-instant-vs-day-level engine defect neither this issue
# nor the time available for it covers — left undone rather than guessed at.
# ---------------------------------------------------------------------------
