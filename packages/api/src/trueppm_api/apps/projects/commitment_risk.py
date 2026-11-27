"""Sprint commitment status, at-risk detection and commitment notices (ADR-1485 D3, D8, D10).

Three things share this module because they share one definition of *at risk*: a
committed task of an ACTIVE sprint that the last recalculation places after the
sprint's finish date.

* :func:`commitment_status_payload` is the read behind
  ``GET /sprints/<id>/commitment-status/``.
* :func:`detect_commitment_at_risk` runs after a recalculation, announces the tasks
  that have just become at risk (webhook ``sprint.commitment_at_risk`` and an
  unmutable in-app notice for the accept authority) and forgets the ones that
  recovered.
* :func:`notify_scope_change_requested` is the batched notice for a change awaiting
  a decision.

Nothing here computes a schedule date. At-risk is a comparison of the task's stored
CPM ``early_finish`` with the sprint's ``finish_date``; the slip in working days is
read with the variance read's own calendar arithmetic; ``cause`` is the engine's
derivation sentence from :func:`~trueppm_api.apps.scheduling.derivation_summary.finish_causes`.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

#: Task names listed in a notice body before it says "and N more".
_NOTICE_NAME_LIMIT = 5

_suppressed: ContextVar[bool] = ContextVar("commitment_detection_suppressed", default=False)


@contextmanager
def suppress_commitment_detection() -> Iterator[None]:
    """Skip :func:`detect_commitment_at_risk` for the duration of the block.

    For a schedule run that no person caused, where a notice would be noise: the demo
    seed's landing overlay schedules the sample program, and its sprints already
    carry committed tasks past their ends, so the run would otherwise fill the demo
    inboxes with at-risk notices before any visitor arrives.
    """
    token = _suppressed.set(True)
    try:
        yield
    finally:
        _suppressed.reset(token)


def _at_risk_queryset(sprint: Any) -> Any:
    """Committed, unfinished tasks whose recalculated finish is after the sprint's end.

    ``committed_sprint_tasks`` is the one definition of "in the commitment"
    (ADR-0102): it already leaves out pending injections and deleted tasks. A task
    with no CPM finish yet, a finished task and a completed one cannot be at risk.
    """
    from trueppm_api.apps.projects.models import TaskStatus, committed_sprint_tasks

    return (
        committed_sprint_tasks(sprint.pk)
        .filter(early_finish__gt=sprint.finish_date, actual_finish__isnull=True)
        .exclude(status=TaskStatus.COMPLETE)
        .exclude(percent_complete__gte=100)
        .order_by("early_finish", "name", "pk")
    )


def _working_days_late(sprint: Any, tasks: list[Any]) -> dict[Any, int | None]:
    """``{task_id: working days between the sprint end and the task's finish}``."""
    from trueppm_api.apps.projects.baseline_variance import _finish_delta, _memoized_count
    from trueppm_api.apps.scheduling.calendars import project_sched_calendars

    if not tasks:
        return {}
    calendar = project_sched_calendars([sprint.project_id])[str(sprint.project_id)]
    count = _memoized_count(calendar)
    return {
        t.pk: _finish_delta((sprint.finish_date, False), (t.early_finish, False), calendar, count)
        for t in tasks
    }


def _requester_name(user: Any) -> str | None:
    if user is None:
        return None
    return str(user.get_full_name() or user.get_username())


def commitment_status_payload(sprint: Any) -> dict[str, Any]:
    """The ``commitment-status`` body: at-risk committed tasks and open scope changes.

    ``at_risk`` is read from the last recalculation's stored finishes and carries the
    provenance of each finish (``cause``, ``derivation_ref``; ADR-1485 D10.2), which
    costs one CPM pass for the whole list. An ACTIVE sprint is the only one with a
    commitment to be at risk against, so any other state reads empty.
    ``open_scope_changes`` lists the PENDING rows of both kinds. Names are returned
    to a caller who is already a project member, as on the existing scope-changes read.
    """
    from trueppm_api.apps.projects.models import (
        ScopeChangeStatus,
        SprintScopeChange,
        SprintState,
    )
    from trueppm_api.apps.scheduling.derivation_summary import finish_causes

    now = timezone.now()
    at_risk: list[dict[str, Any]] = []
    if sprint.state == SprintState.ACTIVE:
        tasks = list(_at_risk_queryset(sprint))
        late = _working_days_late(sprint, tasks)
        causes = finish_causes(sprint.project, {str(t.pk): t.early_finish for t in tasks})
        at_risk = [
            {
                "task_id": t.pk,
                "task_name": t.name,
                "finish": t.early_finish,
                "working_days_after_sprint_end": late[t.pk],
                **causes[str(t.pk)],
            }
            for t in tasks
        ]

    rows = (
        SprintScopeChange.objects.filter(sprint_id=sprint.pk, status=ScopeChangeStatus.PENDING)
        .select_related("task", "added_by")
        .order_by("added_at", "pk")
    )
    open_changes = [
        {
            "id": r.pk,
            "kind": r.kind,
            "batch_id": r.batch_id,
            "task_id": r.task_id,
            "task_name": r.item_name,
            "requested_by": r.added_by_id,
            "requested_by_name": _requester_name(r.added_by),
            "requested_at": r.added_at,
            "age_seconds": max(0, int((now - r.added_at).total_seconds())),
            "proposed_start": r.proposed_start,
            "proposed_finish": r.proposed_finish,
            "reason": r.reason,
        }
        for r in rows
    ]
    return {
        "sprint_id": sprint.pk,
        "sprint_finish_date": sprint.finish_date,
        "at_risk_count": len(at_risk),
        "at_risk": at_risk,
        "open_scope_change_count": len(open_changes),
        "oldest_open_age_seconds": open_changes[0]["age_seconds"] if open_changes else None,
        "open_scope_changes": open_changes,
        "as_of": now,
    }


def _notice_names(names: list[str]) -> str:
    shown = ", ".join(f'"{n}"' for n in names[:_NOTICE_NAME_LIMIT])
    extra = len(names) - _NOTICE_NAME_LIMIT
    return f"{shown} and {extra} more" if extra > 0 else shown


def detect_commitment_at_risk(project_id: Any) -> int:
    """Announce committed tasks that a recalculation has just pushed past a sprint's end.

    Called once after every successful recalculation, single-project or program,
    and after a sprint is activated, which changes the at-risk set without a
    recalculation. (An active sprint's dates cannot be edited, ADR-0073, so no other
    sprint write needs it.) For each ACTIVE sprint it diffs the current
    at-risk set with :class:`SprintCommitmentRisk` (the ones already announced):
    tasks newly at risk are announced once, tasks no longer at risk are forgotten so
    a later relapse is announced again. Per sprint, the diff, the in-app notices, the
    dedupe rows and the webhook's delivery rows are one transaction under the
    sprint's row lock, so two detections of one sprint cannot both announce a task,
    and a crash leaves nothing marked announced for the next run to skip. The
    delivery jobs are queued after that commit.

    Never raises, and each sprint is isolated from the others: the caller is a
    recalculation that has already persisted, and neither a notice nor a webhook is
    worth failing or retrying one over. Returns the number of tasks announced.
    """
    from trueppm_api.apps.projects.models import Sprint, SprintState

    if _suppressed.get():
        return 0
    announced = 0
    try:
        sprints = list(
            Sprint.objects.filter(
                project_id=project_id, state=SprintState.ACTIVE, is_deleted=False
            ).select_related("project")
        )
    except Exception:
        logger.warning(
            "commitment at-risk detection failed for project %s", project_id, exc_info=True
        )
        return 0
    for sprint in sprints:
        try:
            announced += _detect_for_sprint(sprint)
        except SoftTimeLimitExceeded:
            # The soft limit fired after the CPM results persisted. Re-raising would
            # land in the recalculation's timeout handler, which dead-letters the run
            # and broadcasts cpm_error for a schedule that was in fact saved. Stop
            # here instead and let the task return inside the grace period before
            # the hard limit; the sprints left unchecked are checked by the next
            # recalculation, since nothing was recorded for them.
            logger.warning(
                "commitment at-risk detection for project %s stopped at the soft time limit",
                project_id,
            )
            break
        except Exception:
            logger.warning(
                "commitment at-risk detection failed for sprint %s", sprint.pk, exc_info=True
            )
    return announced


def _detect_for_sprint(sprint: Any) -> int:
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications
    from trueppm_api.apps.projects.models import Sprint, SprintCommitmentRisk, SprintState
    from trueppm_api.apps.projects.services import _sprint_lead_recipient_ids
    from trueppm_api.apps.projects.views import _dispatch_webhooks

    with transaction.atomic():
        # Serialize concurrent detections of one sprint on its row (a project run and
        # its program run finishing back to back). The lock is held until this
        # transaction commits, and every write below, including the dedupe rows, is
        # in it, so a second detection waits here and then reads the first one's
        # rows: it cannot see a task as new that the first already announced.
        Sprint.objects.select_for_update().filter(pk=sprint.pk).first()
        # Re-read the sprint under the lock: an edit to its end date or state that
        # committed while this run waited decides what is at risk now.
        sprint = (
            Sprint.objects.select_related("project")
            .filter(pk=sprint.pk, state=SprintState.ACTIVE, is_deleted=False)
            .first()
        )
        if sprint is None:
            return 0
        tasks = list(_at_risk_queryset(sprint))
        flagged = {r.task_id: r for r in SprintCommitmentRisk.objects.filter(sprint_id=sprint.pk)}
        current_ids = {t.pk for t in tasks}

        gone = [r.pk for tid, r in flagged.items() if tid not in current_ids]
        if gone:
            SprintCommitmentRisk.objects.filter(pk__in=gone).delete()
        for t in tasks:
            row = flagged.get(t.pk)
            if row is not None and row.finish != t.early_finish:
                row.finish = t.early_finish
                row.save(update_fields=["finish"])
        new = [t for t in tasks if t.pk not in flagged]
        if not new:
            return 0
        late = _working_days_late(sprint, new)
        pid = str(sprint.project_id)
        payload = {
            "project": pid,
            "sprint": str(sprint.pk),
            "task_count": len(new),
            "tasks": [
                {
                    "task": str(t.pk),
                    "finish": t.early_finish.isoformat(),
                    "working_days_after_sprint_end": late[t.pk],
                }
                for t in new
            ],
            "sprint_finish_date": sprint.finish_date.isoformat(),
        }
        names = [t.name for t in new]
        count = len(new)
        # One notice per recipient per run, however many tasks are newly at risk.
        create_event_notifications(
            event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK,
            recipient_ids=_sprint_lead_recipient_ids(sprint.project_id, None),
            project_id=sprint.project_id,
            subject=(
                f"{count} committed task{'s' if count != 1 else ''} at risk of missing "
                f"the end of {sprint.name}"
            ),
            body=(
                f"After the last recalculation, {_notice_names(names)} "
                f"{'are' if count != 1 else 'is'} expected to finish after "
                f"{sprint.name} ends on {sprint.finish_date.isoformat()}."
            ),
            task_id=new[0].pk if count == 1 else None,
        )
        # The dedupe rows, the notices and the webhook's delivery rows (ADR-1485 D6,
        # ids and working-day deltas only) commit together or not at all: a crash
        # before the commit leaves nothing marked announced, and the next detection
        # announces again. The delivery jobs are queued only after the commit, so a
        # worker never looks for a row that is not there yet.
        SprintCommitmentRisk.objects.bulk_create(
            [
                SprintCommitmentRisk(sprint_id=sprint.pk, task_id=t.pk, finish=t.early_finish)
                for t in new
            ]
        )
        _dispatch_webhooks(pid, "sprint.commitment_at_risk", payload, enqueue_on_commit=True)
    return len(new)


def notify_scope_change_requested(row: Any) -> None:
    """Tell the accept authority a change to the sprint's commitment awaits a decision.

    Slips of one request share a ``batch_id``, so they share one notice per
    recipient that is rewritten as each further row lands ("3 tasks · accept all /
    review"). An injection has no batch, so each is its own notice. The requester is
    never told about their own request. Runs inside the write's transaction: the
    notice and the row commit together, and the email, when a recipient opted into
    it, goes out through the existing notification-email drain.

    Best-effort by design for the write it rides on: a failure is logged and
    swallowed, because a notice is not worth refusing the request that caused it.
    """
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import (
        create_event_notifications,
        upsert_grouped_event_notification,
    )
    from trueppm_api.apps.projects.models import (
        ScopeChangeKind,
        ScopeChangeStatus,
        SprintScopeChange,
    )
    from trueppm_api.apps.projects.services import _sprint_lead_recipient_ids

    try:
        project_id = row.task.project_id
        recipients = _sprint_lead_recipient_ids(project_id, row.added_by_id)
        if not recipients:
            return
        sprint_name = row.sprint.name
        with transaction.atomic():
            if row.kind == ScopeChangeKind.SLIP and row.batch_id:
                names = list(
                    SprintScopeChange.objects.filter(
                        batch_id=row.batch_id, status=ScopeChangeStatus.PENDING
                    )
                    .order_by("added_at", "pk")
                    .values_list("subtask_name", flat=True)
                )
                count = len(names)
                upsert_grouped_event_notification(
                    event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED,
                    recipient_ids=recipients,
                    project_id=project_id,
                    group_key=f"batch:{row.batch_id}",
                    subject=(
                        f"{count} commitment change{'s' if count != 1 else ''} awaiting "
                        f"your decision in {sprint_name}"
                    ),
                    body=(
                        f"{count} task{'s' if count != 1 else ''} · accept all / review: "
                        f"{_notice_names(names)}. Dates move only when someone with the "
                        f"authority to accept them does."
                    ),
                    task_id=row.task_id if count == 1 else None,
                )
            else:
                create_event_notifications(
                    event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED,
                    recipient_ids=recipients,
                    subject=f"A task was added to {sprint_name} and awaits your decision",
                    body=(
                        f'"{row.item_name}" was added to {sprint_name} after it started. '
                        "It stays out of the commitment until someone accepts it."
                    ),
                    project_id=project_id,
                    task_id=row.task_id,
                )
    except Exception:
        logger.warning(
            "scope-change notice failed for row %s", getattr(row, "pk", None), exc_info=True
        )
