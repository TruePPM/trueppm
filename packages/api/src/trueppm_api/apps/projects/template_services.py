"""Dispatch and undo for template application (ADR-0789, #2729).

Every caller goes through :func:`enqueue_template_apply` — nothing calls the Celery
task directly. Same rule, same reason as ``scheduling/services.py::enqueue_recalculate``:
a direct ``.delay()`` at the view layer commits the database change and then loses
the task if the broker is down, which is precisely the failure the outbox exists to
prevent.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils import timezone

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import (
        Project,
        ProjectTemplate,
        TemplateApplication,
    )

logger = logging.getLogger(__name__)


def enqueue_template_apply(
    template: ProjectTemplate,
    project: Project,
    *,
    applied_by: Any = None,
) -> TemplateApplication:
    """Record the adoption and queue the seeding job.

    The ``TemplateApplication`` row is written **inside the caller's transaction**
    and the dispatch is deferred to ``transaction.on_commit``. That ordering is the
    whole durability story: a row that commits without its task is recoverable (the
    drain finds it), while a task that fires before its row commits would look up an
    application that does not exist yet.

    Returns the application immediately — the Start sheet polls it and never blocks
    on seeding (issue §2).
    """
    from trueppm_api.apps.access.permissions import assert_project_not_archived
    from trueppm_api.apps.projects.models import TemplateApplication

    # Archived is lifecycle state, not authority — a property of the target plan, so
    # it holds regardless of who is calling (#3354). This module's contract is that
    # *every* caller comes through here, which makes it the one place the check
    # cannot be routed around; `ProjectTemplateViewSet.apply` repeats it so the
    # refusal arrives before any row is written (ADR-0184 defense-in-depth).
    assert_project_not_archived(project)

    application = TemplateApplication.objects.create(
        template=template,
        template_name=template.name,
        template_version=template.version,
        project=project,
        applied_by=applied_by,
    )

    def _dispatch() -> None:
        from trueppm_api.apps.projects.template_tasks import apply_template

        try:
            result = apply_template.delay(str(application.id))
            TemplateApplication.objects.filter(pk=application.pk).update(
                celery_task_id=str(result.id)
            )
        except Exception:
            # Deliberately swallowed: the row is committed and `pending`, so the
            # drain re-dispatches it within the orphan window. Raising here would
            # turn a recoverable broker blip into a user-visible 500 on a write
            # that already succeeded.
            logger.warning(
                "template.apply: dispatch failed for application %s — leaving to drain",
                application.id,
                exc_info=True,
            )

    transaction.on_commit(_dispatch)
    return application


def undo_template_application(application: TemplateApplication) -> dict[str, int]:
    """Reverse one application — a single step from the user's side.

    Soft-deletes the rows this application wrote, and **only** those: the undo set
    is ``created_task_ids``, not a heuristic over the project.

    It deliberately skips rows a person has since touched. An undo that discards
    typed work in order to reverse a machine's write is the same unrecoverable
    failure ADR-0786 §4 is organized around, and the asymmetry is identical —
    leaving a row behind is disappointing, deleting a sentence somebody wrote is
    not recoverable. Whoever undoes a template five minutes after a teammate
    started filling it in must not take the teammate's work with it.

    "Has a person touched this" is ``edited_at IS NOT NULL`` (ADR-0786, merged in
    !1900). That column is stamped by ``Task.save()`` and deliberately NOT by the
    CPM ``bulk_update`` path (ADR-0091), so a recalculation between apply and undo
    does not falsely protect every row and turn undo into a no-op.
    """
    from trueppm_api.apps.access.permissions import assert_project_not_archived
    from trueppm_api.apps.projects.models import Task, TemplateApplicationStatus

    # Lifecycle floor, mirroring `enqueue_template_apply` above and the two
    # `task_batch_services` undos: an undo soft-deletes rows, which is a write, and
    # an archived plan takes no writes from any caller (#3354).
    assert_project_not_archived(application.project_id)

    ids = list(application.created_task_ids or [])
    if not ids:
        application.status = TemplateApplicationStatus.UNDONE
        application.undone_at = timezone.now()
        application.save(update_fields=["status", "undone_at"])
        return {"deleted": 0, "kept": 0}

    rows = list(Task.objects.filter(pk__in=ids, is_deleted=False))
    deleted = 0
    kept = 0
    for row in rows:
        if _has_been_touched(row):
            kept += 1
            continue
        row.soft_delete()
        deleted += 1

    application.status = TemplateApplicationStatus.UNDONE
    application.undone_at = timezone.now()
    application.result_summary = {
        **(application.result_summary or {}),
        "undo": {"deleted": deleted, "kept": kept},
    }
    application.save(update_fields=["status", "undone_at", "result_summary"])
    return {"deleted": deleted, "kept": kept}


def _has_been_touched(task: Any) -> bool:
    """Has a person saved this row since the template wrote it? (ADR-0786)"""
    return task.edited_at is not None
