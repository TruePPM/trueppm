"""Celery tasks for template application (ADR-0789, #2729).

Mirrors ``csvimport.tasks`` — same claim-and-run idempotency, same drain, same
orphan window — because it is the same problem: a queued seeding job that must run
exactly once even under redelivery, worker death, or a broker outage.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from celery import shared_task

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# An apply running longer than this is considered orphaned by the drain. Slightly
# longer than the soft limit so the task gets the chance to record its own failure
# before the drain resets the row underneath it.
_APPLY_ORPHAN_MINUTES = 15

# Rows inside an open transaction.on_commit() callback are invisible until the
# commit lands, so the drain skips rows younger than this rather than racing an
# in-flight request it would otherwise dispatch a second time.
_DRAIN_MIN_AGE_MINUTES = 10


def _claim(application_id: str) -> Any:
    """Atomically take an application from ``pending`` to ``running``.

    Returns the claimed row, or ``None`` when another delivery already has it.
    ``select_for_update`` makes the read-modify-write one critical section, so two
    concurrent deliveries cannot both claim — the loser sees ``running`` and skips.
    """
    from django.utils import timezone

    from trueppm_api.apps.projects.models import (
        TemplateApplication,
        TemplateApplicationStatus,
    )

    row = (
        TemplateApplication.objects.select_for_update()
        # `project` is joined rather than lazily fetched because the caller reads
        # `application.project.is_archived` while this row lock is held (#3354) —
        # a lazy FK there would add a round trip inside the critical section.
        # `select_for_update` locks only `template_application`; the join does not
        # widen it (Postgres would need `of=` for that).
        .select_related("project")
        .filter(pk=application_id, status=TemplateApplicationStatus.PENDING)
        .first()
    )
    if row is None:
        return None
    row.status = TemplateApplicationStatus.RUNNING
    row.started_at = timezone.now()
    row.save(update_fields=["status", "started_at"])
    return row


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    name="templates.apply",
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=3,
)
def apply_template(self: Any, application_id: str) -> dict[str, Any]:
    """Materialize a template into its project, then queue a CPM pass.

    The claim and the seeding share one transaction, so a mid-apply failure rolls
    the claim back too and the row returns to ``pending`` for a clean retry. A
    duplicate delivery — a drain re-dispatch after a worker-death window, or an
    ``acks_late`` replay of an already-completed message — finds no ``pending`` row
    to claim and skips.
    """
    from django.db import transaction
    from django.utils import timezone

    from trueppm_api.apps.projects.models import (
        TemplateApplicationStatus,
    )
    from trueppm_api.apps.projects.project_templates import (
        TemplateStructureError,
        materialize_structure,
    )

    created: list[Any] = []
    project_id: str | None = None
    try:
        with transaction.atomic():
            application = _claim(application_id)
            if application is None:
                logger.info(
                    "templates.apply: application %s already claimed — skipping duplicate",
                    application_id,
                )
                return {"skipped": True, "tasks_created": 0}
            if application.template is None:
                # The template was deleted between enqueue and dispatch. Fail
                # loudly rather than silently succeeding with zero rows — the user
                # asked for a skeleton and did not get one.
                raise TemplateStructureError("Template no longer exists.")
            if application.project.is_archived:
                # The project was archived between enqueue and dispatch (#3354).
                # `enqueue_template_apply` refuses an already-archived target, but
                # the window here is wide, not theoretical: dispatch is deferred to
                # `on_commit`, and the drain re-dispatches a still-`pending`
                # application every 30s for as long as it stays pending — so a
                # broker outage at enqueue time can put this write minutes or hours
                # after the check that admitted it. Seeding now would write a whole
                # skeleton into a plan every other endpoint refuses writes to.
                #
                # Raised as a `TemplateStructureError` for the same reason the
                # deleted-template branch above is: it is the file's established
                # non-retryable channel — the atomic rolls back (releasing the
                # `running` claim), `_mark_failed` records the reason outside it,
                # and the drain does not resurrect it. Retrying would be wrong
                # regardless: unarchiving is a human act on no schedule, and three
                # retries 30s apart cannot wait for one.
                raise TemplateStructureError(
                    "This project is archived and cannot be modified. Unarchive it first."
                )
            project_id = str(application.project_id)
            result = materialize_structure(
                application.template,
                application.project,
                applied_by=application.applied_by,
            )
            created = result.task_ids
            application.created_task_ids = created
            application.status = TemplateApplicationStatus.SUCCESS
            application.completed_at = timezone.now()
            # Counts feed the seed banner (#2731, ADR-0799 §2) — read off what
            # materialize_structure already built in memory, never re-derived from
            # a second query against the rows it just wrote.
            application.result_summary = {
                "tasks_created": len(created),
                "milestones_created": result.milestones_created,
                "dependencies_created": result.dependencies_created,
            }
            application.save(
                update_fields=[
                    "created_task_ids",
                    "status",
                    "completed_at",
                    "result_summary",
                ]
            )
    except TemplateStructureError as exc:
        # A malformed or unsupported structure is not retryable — retrying would
        # re-read the same bad document three more times and delay the user's
        # failure message by ten minutes.
        _mark_failed(application_id, str(exc))
        return {"failed": True, "tasks_created": 0}
    except Exception as exc:
        if self.request.retries >= self.max_retries:
            # Partially-written rows are deliberately KEPT (ADR-0789 §Durable
            # Execution 8) — they are real, correctly-attributed tasks, and
            # created_task_ids records exactly which, so undo stays exact.
            _mark_failed(application_id, str(exc))
            return {"failed": True, "tasks_created": 0}
        raise self.retry(exc=exc, countdown=2**self.request.retries * 30) from exc

    if created and project_id:
        # Dates come from the adopter's calendar, not the publisher's — the
        # template carries durations and shape only, so the schedule does not
        # exist until this pass runs. Through the service, never .delay() directly.
        from trueppm_api.apps.scheduling.services import enqueue_recalculate
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        enqueue_recalculate(project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(str(project_id), "tasks_restructured", {})
        )

    return {"tasks_created": len(created)}


def _mark_failed(application_id: str, detail: str) -> None:
    """Record a terminal failure on its own transaction.

    Its own transaction because the caller's has usually just rolled back — writing
    the failure inside it would roll back with it and leave the row at ``running``
    forever, which the drain would then keep resurrecting.
    """
    from django.utils import timezone

    from trueppm_api.apps.projects.models import (
        TemplateApplication,
        TemplateApplicationStatus,
    )

    TemplateApplication.objects.filter(pk=application_id).update(
        status=TemplateApplicationStatus.FAILED,
        error_detail=detail[:2000],
        completed_at=timezone.now(),
    )


@idempotent_task(
    lock_key_template="drain_template_apply_queue",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="templates.drain_apply_queue",
)
def drain_template_apply_queue(self: object) -> None:
    """Dispatch pending applications; recover ones whose worker died.

    Runs every 30 seconds via Celery Beat — the safety net that makes
    ``enqueue_template_apply``'s best-effort ``.delay()`` durable.
    """
    _do_template_apply_drain()


def _do_template_apply_drain() -> None:
    """Business logic for the drain — extracted so it is testable without Beat."""
    from django.utils import timezone

    from trueppm_api.apps.projects.models import (
        TemplateApplication,
        TemplateApplicationStatus,
    )

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=_APPLY_ORPHAN_MINUTES)
    pending_cutoff = now - timedelta(minutes=_DRAIN_MIN_AGE_MINUTES)

    recovered = TemplateApplication.objects.filter(
        status=TemplateApplicationStatus.RUNNING,
        started_at__lt=orphan_cutoff,
    ).update(status=TemplateApplicationStatus.PENDING, celery_task_id="")
    if recovered:
        logger.warning("templates.drain: recovered %d orphaned application(s)", recovered)

    pending = list(
        TemplateApplication.objects.filter(
            status=TemplateApplicationStatus.PENDING,
            created_at__lt=pending_cutoff,
        ).values_list("id", flat=True)[:100]
    )
    for application_id in pending:
        try:
            apply_template.delay(str(application_id))
        except Exception:
            # Broker still down — leave it pending and try again in 30 seconds.
            logger.warning(
                "templates.drain: re-dispatch failed for %s", application_id, exc_info=True
            )
