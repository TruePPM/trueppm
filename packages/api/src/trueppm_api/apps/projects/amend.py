"""Amend: a structural edit to a committed plan carries a reason (#2964).

Once a plan is committed (ADR-0845), the same keystrokes that built a greenfield
draft are now editing something other people planned around. Before this, they
were indistinguishable: no different prompt, no record, no signal to anyone.

Three properties, and the third is the one most likely to be eroded later:

1. **The reason lands in plan history.** Free text, no category picker — a
   dropdown of six blessed reasons collects the nearest wrong one, which is worse
   than nothing because it looks like data.
2. **It reaches the people whose work moved**, not only the person who clicked.
3. **It is never a block.** Amend records and tells. It does not gate, refuse, or
   require approval. A planner who cannot change a committed plan will keep the
   real plan somewhere else, and then the tool is describing fiction.

Not every edit is an amend. A draft is still a draft — authoring a plan nobody
has agreed to yet must stay frictionless, or the commit moment becomes something
people avoid rather than something they reach for.
"""

from __future__ import annotations

import logging
from functools import partial
from typing import TYPE_CHECKING, Any

from django.db import transaction

if TYPE_CHECKING:
    from .models import Project, Task

logger = logging.getLogger(__name__)

#: What a reason is attached to in `HistoricalTask.history_change_reason`.
AMEND_PREFIX = "amend"


def is_amendable(project: Project) -> bool:
    """True when edits to this project are amendments rather than authoring.

    Keyed on lifecycle, not on the presence of a baseline: a project can be
    committed and its baseline capture could conceivably fail, and in that state
    edits are still edits to something people agreed to.
    """
    from .models import ProjectLifecycle

    return project.lifecycle == ProjectLifecycle.ACTIVE


def record_amend_reason(task: Task, reason: str | None) -> None:
    """Attach the reason to the row's next history entry.

    ``_change_reason`` is simple_history's hook and is already how this codebase
    annotates history (`services.py`, scope acceptance). Setting it here means the
    reason rides the *existing* history write rather than needing a parallel audit
    table that could disagree with it.

    A blank reason is stored as the bare marker rather than being dropped: "someone
    amended this and did not say why" is itself worth knowing, and is different
    from "this was never amended".
    """
    text = (reason or "").strip()
    task._change_reason = f"{AMEND_PREFIX}: {text}" if text else AMEND_PREFIX  # type: ignore[attr-defined]


def notify_amend(task: Task, *, actor: Any, reason: str | None) -> None:
    """Tell the people whose work this changed.

    Recipients are everyone with a **resource assignment** on the task, minus the
    actor. Deliberately ``TaskResource`` rather than ``Task.assignee``: capacity,
    utilization and sprint capacity all sum ``TaskResource.units``, and a bare
    assignee carries no load and may never reach the person — so notifying off it
    would tell the wrong set of people that their own committed work moved.

    Best-effort and deferred to ``transaction.on_commit``: a notification failure
    must never revert an edit that has already been accepted. Amend is not a gate,
    and a failure here must not accidentally turn it into one (the ADR-0232
    carryover pattern, as used by ``notify_sprint_membership_change``).
    """
    from trueppm_api.apps.resources.models import TaskResource

    actor_id = actor.pk if actor is not None and getattr(actor, "is_authenticated", False) else None

    assigned = TaskResource.objects.filter(task_id=task.pk)
    if actor_id is not None:
        # Only exclude when there IS an actor. `.exclude(field=None)` would drop
        # every resource with no linked user, which is the opposite of intent.
        assigned = assigned.exclude(resource__user_id=actor_id)
    recipient_ids = list(assigned.values_list("resource__user_id", flat=True).distinct())
    recipient_ids = [rid for rid in recipient_ids if rid is not None]
    if not recipient_ids:
        return

    body = _amend_body(
        getattr(actor, "username", "") or "Someone",
        task.name,
        reason,
    )
    rows = [(rid, "A committed plan changed", body, str(task.pk)) for rid in recipient_ids]
    transaction.on_commit(partial(_emit_amend_notifications, str(task.project_id), rows, task.pk))


def _amend_body(actor_name: str, task_name: str, reason: str | None) -> str:
    """The notice text.

    States the reason when there is one and says so plainly when there is not —
    "no reason given" is information, and quietly omitting the clause would make
    an unexplained change look like an explained one.
    """
    text = (reason or "").strip()
    label = task_name or "Untitled"
    if text:
        return f"{actor_name} changed “{label}” on a committed plan — {text}"
    return f"{actor_name} changed “{label}” on a committed plan. No reason was given."


def _emit_amend_notifications(
    project_id: str,
    rows: list[tuple[Any, str, str, str]],
    task_pk: Any,
) -> None:
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch

    try:
        create_event_notifications_batch(
            event_type=NotificationEventType.PLAN_AMENDED,
            project_id=project_id,
            rows=rows,
        )
    except Exception:
        logger.exception("notify_amend: emit failed for task %s", task_pk)
