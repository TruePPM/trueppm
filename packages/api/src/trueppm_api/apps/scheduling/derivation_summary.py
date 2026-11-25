"""The server's one-line "cause" of a task's current finish (ADR-1485 D10, #5129).

A sentence composed from the engine's own derivation
(:func:`trueppm_scheduler.derive_value`), so a client prints it and an agent
quotes it without composing schedule reasoning of its own. Nothing here computes
a date or a duration: every value in the sentence is read off the derivation.
``derivation_ref`` points at the full contribution chain behind it.
"""

from __future__ import annotations

from datetime import date
from typing import Any

#: The quantity every cause explains: the task's current finish.
DERIVATION_QUANTITY = "early_finish"

SUMMARY_CAUSE = "Rolled up from its subtasks."


def _day(value: date | None) -> str:
    return value.isoformat() if value else "an unrecorded date"


def _constraint_sentence(contribution: Any) -> str | None:
    """One sentence for a binding constraint, or ``None`` for a kind with none."""
    kind = contribution.kind
    when = _day(contribution.imposed_date)
    if kind.startswith("predecessor_"):
        lag = contribution.lag_days or 0
        lag_text = f", {lag:+d} calendar day(s) lag" if lag else ""
        link = contribution.dep_type or kind.removeprefix("predecessor_").upper()
        return f"Driven by '{contribution.source_task_name}' ({link} link{lag_text}): {when}."
    sentences = {
        "actual_finish": f"Finished {when} (recorded actual finish).",
        "actual_start": f"Started {when} (recorded actual start).",
        "planned_start_snet": f"Held to a start no earlier than {when}.",
        "project_start": f"Starts at the project start, {when}.",
        "data_date": f"Remaining work is scheduled from the data date, {when}.",
    }
    return sentences.get(kind)


def finish_causes(project: Any, expected: dict[str, date | None]) -> dict[str, dict[str, Any]]:
    """``{task_id: {"cause", "derivation_ref"}}`` for the given tasks.

    Runs **one** CPM pass for the whole batch and derives each task from it, so a
    page costs one pass, not one per row. ``expected`` maps each task id to the
    finish the caller is about to show; when the fresh pass disagrees (a
    recalculation is still pending) the cause is ``None`` rather than a sentence
    explaining a different date.

    A summary task reads :data:`SUMMARY_CAUSE` with no ref (its dates are rolled
    up, never produced by a pass). A task outside the scheduled network, or a
    graph the engine refuses, yields ``None`` for both.
    """
    from trueppm_scheduler.derive import UnknownTaskError, derive_value
    from trueppm_scheduler.engine import SchedulerError, schedule

    from .views import _build_cpm_sched_inputs

    out: dict[str, dict[str, Any]] = {
        task_id: {"cause": None, "derivation_ref": None} for task_id in expected
    }
    if not expected:
        return out
    try:
        sched_project, graph, _, _ = _build_cpm_sched_inputs(project, str(project.pk))
        for task_id in expected:
            if task_id in graph.children_map:
                out[task_id]["cause"] = SUMMARY_CAUSE
        if not sched_project.tasks:
            return out
        result = schedule(sched_project)
    except (SchedulerError, ValueError, OverflowError):
        return out

    scheduled = {t.id for t in result.tasks}
    for task_id, shown in expected.items():
        if task_id not in scheduled:
            continue
        out[task_id]["derivation_ref"] = {"task_id": task_id, "quantity": DERIVATION_QUANTITY}
        try:
            derivation = derive_value(sched_project, task_id, DERIVATION_QUANTITY, result=result)
            if shown is None or derivation.value != shown.isoformat():
                continue
            binding = derivation.binding
            if binding is None:
                continue
            if binding.kind == "duration_from_early_start":
                # The finish is its own work; what holds the *start* is the cause.
                start = derive_value(sched_project, task_id, "early_start", result=result)
                held = _constraint_sentence(start.binding) if start.binding else None
                work = f"{binding.slack_days} working day(s) of work from its start."
                out[task_id]["cause"] = f"{held} Then {work}" if held else work.capitalize()
            else:
                out[task_id]["cause"] = _constraint_sentence(binding)
        except (UnknownTaskError, SchedulerError, ValueError, OverflowError):
            continue
    return out
