"""Randomized ``derive_value()`` oracle (#4440).

``test_derive.py`` checks the faithfulness of one fixed network. This module
asserts the same contract over generated projects — every task x every
:class:`Quantity` — so a derivation that disagrees with the engine (a fabricated
explanation, rule 120) fails on an input nobody wrote down:

1. ``derive_value(...).value`` equals the matching :class:`ScheduleResult` field.
2. Exactly one contribution is flagged ``is_binding`` and it is ``Derivation.binding``.
3. For a date quantity, ``binding.imposed_date == value`` whenever it carries a date.
4. Link removal is monotone on the early (forward) pass: dropping a predecessor
   link the derivation reports as strictly losing must not move any ES/EF, and
   dropping a strictly dominant binding link must move that task's ES. Property 4
   covers the forward pass (ES/EF) only; LS/LF are not asserted. It excludes SF
   links (removing the last one changes the project-start floor; the rule is
   unverified against MS Project, open issue #4319) and projects containing
   zero-duration tasks.

The generator is the plausible-project space of ``test_contract_fuzz`` (all four
link types, negative lag, per-task calendars, calendar exceptions, status date,
actuals, percent complete, SNET) so the two suites cannot drift apart.
"""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta

import pytest
from hypothesis import given

from tests.test_contract_fuzz import _plausible_projects
from trueppm_scheduler import (
    Calendar,
    Project,
    Quantity,
    SchedulerError,
    Task,
    derive_value,
    schedule,
)

pytestmark = pytest.mark.fuzz

_DATE_QUANTITIES = {
    Quantity.EARLY_START,
    Quantity.EARLY_FINISH,
    Quantity.LATE_START,
    Quantity.LATE_FINISH,
    Quantity.SCHEDULED_START,
}


_projects = _plausible_projects() | _plausible_projects(per_task_calendars=True)


def _scheduled(project: Project):  # type: ignore[no-untyped-def]
    """Schedule ``project``, discarding the rare input the engine rejects."""
    try:
        return schedule(project)
    except SchedulerError:
        return None


@pytest.mark.fuzz
@given(project=_projects)
def test_derivation_matches_result_and_has_one_binding(project: Project) -> None:
    result = _scheduled(project)
    if result is None:
        return
    by_id = {t.id: t for t in result.tasks}
    for t in project.tasks:
        for q in Quantity:
            d = derive_value(project, t.id, q, result=result)
            engine_value = getattr(by_id[t.id], q.value)
            # (1) value == the ScheduleResult field.
            if q in _DATE_QUANTITIES:
                expected = engine_value.isoformat() if engine_value is not None else None
                assert d.value == expected, (t.id, q)
            else:
                # Float quantities are whole days (int) on the derivation, a timedelta
                # on the result; type-check so a bool/float/str cannot slip through.
                assert isinstance(d.value, int) and not isinstance(d.value, bool), (t.id, q)
                assert d.value == engine_value.days, (t.id, q)
            # (2) exactly one binding contribution, and it is Derivation.binding.
            flagged = [c for c in d.contributions if c.is_binding]
            assert len(flagged) == 1, (t.id, q, [c.kind for c in flagged])
            assert d.binding is flagged[0], (t.id, q)
            # (3) the binding date reproduces the value for date quantities.
            if q in _DATE_QUANTITIES and d.binding.imposed_date is not None:
                assert d.binding.imposed_date == engine_value, (t.id, q, d.binding.kind)


def _without_link(project: Project, pred: str, succ: str) -> Project:
    deps = [
        dep
        for dep in project.dependencies
        if not (dep.predecessor_id == pred and dep.successor_id == succ)
    ]
    return dataclasses.replace(project, dependencies=deps)


def _early_dates(result) -> dict[str, tuple[date, date]]:  # type: ignore[no-untyped-def]
    return {t.id: (t.early_start, t.early_finish) for t in result.tasks}


@pytest.mark.fuzz
@given(project=_projects.filter(lambda p: all(t.duration.days > 0 for t in p.tasks)))
def test_link_removal_is_monotone_on_the_forward_pass(project: Project) -> None:
    result = _scheduled(project)
    if result is None:
        return
    baseline = _early_dates(result)
    for t in project.tasks:
        d = derive_value(project, t.id, Quantity.EARLY_START, result=result)
        binding = d.binding
        if binding is None or binding.imposed_date is None:
            continue
        for c in d.contributions:
            if (
                c.is_binding
                or not c.kind.startswith("predecessor_")
                or c.imposed_date is None
                or c.source_task_id is None
            ):
                continue
            if c.kind == "predecessor_sf":
                # An SF link exempts its task from the project-start floor (#4220), so
                # removing the last one changes the floor, not just a candidate. That
                # rule is unverified against MS Project (#4319); not this oracle's call.
                continue
            reduced = _scheduled(_without_link(project, c.source_task_id, t.id))
            if reduced is None:
                continue
            # (4a) a strictly losing link carries no weight on the forward pass.
            if c.imposed_date < binding.imposed_date:
                assert _early_dates(reduced) == baseline, (t.id, c.source_task_id, c.kind)

        # (4b) a strictly dominant binding link is load-bearing: removing it must move ES.
        if (
            binding.kind.startswith("predecessor_")
            and binding.kind != "predecessor_sf"  # see the floor note above
            and binding.source_task_id is not None
        ):
            others = [
                c.imposed_date
                for c in d.contributions
                if c is not binding and c.imposed_date is not None
            ]
            if all(o < binding.imposed_date for o in others):
                reduced = _scheduled(_without_link(project, binding.source_task_id, t.id))
                if reduced is None:
                    continue
                new_es = {x.id: x.early_start for x in reduced.tasks}[t.id]
                assert new_es != baseline[t.id][0], (t.id, binding.source_task_id, binding.kind)


def test_completed_no_actuals_binding_reproduces_the_value() -> None:
    """A completed task with no actuals derives its real early start, not the cap (#5079)."""
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        status_date=date(2027, 1, 1),
        calendar=Calendar(working_days=0b0011111),
        tasks=[
            Task(
                id="t1",
                name="t",
                duration=timedelta(days=2),
                planned_start=date(2027, 1, 1),
                percent_complete=100.0,
            )
        ],
    )
    result = schedule(project)
    early_start = result.tasks[0].early_start
    assert early_start is not None
    d = derive_value(project, "t1", Quantity.EARLY_START, result=result)
    assert d.value == early_start.isoformat()
    assert d.binding is not None
    assert d.binding.imposed_date == early_start
