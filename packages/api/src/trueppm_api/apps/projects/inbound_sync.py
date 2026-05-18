"""Inbound task-sync upsert logic (ADR-0068 / issue #500).

Kept in its own module to keep ``views.py`` focused on routing.  The single
public entry point is :func:`upsert_inbound_task`, called from
``TaskSyncView.post`` after authentication, throttling, and IDOR validation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F

from trueppm_api.apps.projects.models import (
    ApiTokenAuditAction,
    ApiTokenAuditEntry,
    InboundTaskLink,
    ProjectApiToken,
    Task,
    TaskStatus,
)

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project

logger = logging.getLogger(__name__)

# Default status_map used when the token has no override.  Lower-case keys
# match the canonical Jira/Linear/GitHub status vocabulary; values are
# TaskStatus.value strings.  Documented in ADR-0068 §1.
DEFAULT_STATUS_MAP: dict[str, str] = {
    "todo": TaskStatus.NOT_STARTED.value,
    "to do": TaskStatus.NOT_STARTED.value,
    "open": TaskStatus.NOT_STARTED.value,
    "backlog": TaskStatus.BACKLOG.value,
    "in_progress": TaskStatus.IN_PROGRESS.value,
    "in progress": TaskStatus.IN_PROGRESS.value,
    "doing": TaskStatus.IN_PROGRESS.value,
    "review": TaskStatus.REVIEW.value,
    "in_review": TaskStatus.REVIEW.value,
    "in review": TaskStatus.REVIEW.value,
    "done": TaskStatus.COMPLETE.value,
    "closed": TaskStatus.COMPLETE.value,
    "complete": TaskStatus.COMPLETE.value,
}


@dataclass
class UpsertResult:
    task: Task
    link: InboundTaskLink
    created: bool
    assignee_resolved: bool


def _resolve_status(payload_status: str | None, token: ProjectApiToken) -> str:
    """Translate the external status string into a TaskStatus value.

    Lookup order: token.status_map (case-insensitive) → DEFAULT_STATUS_MAP
    (case-insensitive) → BACKLOG fallback.  Empty/missing input returns
    BACKLOG so a payload with no status field lands in the backlog rather
    than silently becoming NOT_STARTED (which would imply a PM commitment).
    """
    if not payload_status:
        return TaskStatus.BACKLOG.value
    key = payload_status.strip().lower()
    # Token overrides may use their own casing; normalize on lookup.
    override = {k.lower(): v for k, v in (token.status_map or {}).items()}
    if key in override:
        candidate = override[key]
    elif key in DEFAULT_STATUS_MAP:
        candidate = DEFAULT_STATUS_MAP[key]
    else:
        candidate = TaskStatus.BACKLOG.value
    # Defensive: if a token's status_map is misconfigured with an invalid
    # TaskStatus, fall back to BACKLOG rather than raise — the inbound caller
    # should not be punished for a token-config bug they can't see.
    if candidate not in TaskStatus.values:
        logger.warning(
            "inbound_sync: token %s mapped status %r to invalid TaskStatus %r",
            token.token_prefix,
            payload_status,
            candidate,
        )
        return str(TaskStatus.BACKLOG.value)
    return str(candidate)


def _resolve_assignee(
    assignee_email: str | None, project: Project
) -> tuple[Any | None, str | None]:
    """Resolve an email against project membership.

    Returns ``(user, None)`` if the email matches a member, else
    ``(None, pending_email)`` so the link row carries the unresolved email
    for later resolution.  Empty/missing input returns ``(None, None)``.
    """
    if not assignee_email:
        return (None, None)
    User = get_user_model()
    # Lookup by email (case-insensitive) and confirm the user is a non-soft-deleted
    # member.  Avoids leaking project membership across emails — only matches if
    # the email belongs to a current member.
    user = (
        User.objects.filter(email__iexact=assignee_email)
        .filter(
            memberships__project=project,
            memberships__is_deleted=False,
        )
        .first()
    )
    if user is not None:
        return (user, None)
    return (None, assignee_email)


def _resolve_parent_wbs(
    project: Project, source: str, parent_external_id: str | None
) -> str | None:
    """Find the WBS path of a parent task from its external id.

    Match is scoped to the same (project, source) so a Jira epic can't be
    reparented under a Linear story (downgrade attack from STRIDE §EoP #4).
    Returns ``None`` if no match — caller treats this as a flat BACKLOG item.
    """
    if not parent_external_id:
        return None
    parent_link = (
        InboundTaskLink.objects.filter(
            project=project,
            source=source,
            external_id=parent_external_id,
            is_deleted=False,
        )
        .select_related("task")
        .first()
    )
    if parent_link is None or parent_link.task.wbs_path is None:
        return None
    return str(parent_link.task.wbs_path)


@transaction.atomic
def upsert_inbound_task(
    *,
    project: Project,
    token: ProjectApiToken,
    payload: dict[str, Any],
    source_ip: str | None,
) -> UpsertResult:
    """Idempotent upsert by (project, source, external_id).

    On match: write-through of name, description, story_points, external_url,
    and status (translated via the token's status_map).  ``assignee`` is set
    only on resolve — a previously-resolved assignee is *not* overwritten by
    a re-push (prevents a compromised token from silently rewriting human
    ownership decisions).

    On no match: creates the Task with ``status`` from the status_map (or
    BACKLOG fallback), attaches under ``parent_external_id`` if a matching
    parent link exists, and writes the link row.

    Side effects (all in transaction.on_commit()):
      - broadcast_board_event(project_id, "task_created" | "task_updated", ...)
      - dispatch_webhooks(project_id, "task.created" | "task.updated", payload)
      - enqueue_recalculate(project_id) for CPM (idempotent — coalesced by
        the ScheduleRequest outbox)

    Writes an ApiTokenAuditEntry "used" row inside the same transaction.
    """
    from trueppm_api.apps.scheduling.services import (
        enqueue_recalculate as _enqueue_recalculate,
    )
    from trueppm_api.apps.sync.broadcast import broadcast_board_event
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    source = payload["source"]
    external_id = payload["external_id"]
    name = payload.get("name") or external_id  # name is recommended but not required
    description = payload.get("description") or ""
    story_points = payload.get("story_points")
    external_url = payload.get("external_url") or None
    parent_external_id = payload.get("parent_external_id") or None
    assignee_email = payload.get("assignee_email") or None

    status_value = _resolve_status(payload.get("status"), token)
    assignee_user, pending_email = _resolve_assignee(assignee_email, project)
    parent_wbs = _resolve_parent_wbs(project, source, parent_external_id)

    link = (
        InboundTaskLink.objects.select_for_update()
        .select_related("task")
        .filter(project=project, source=source, external_id=external_id, is_deleted=False)
        .first()
    )

    created = link is None
    if created:
        # Allocate a WBS path: under the parent if one was resolved, else as
        # a new root-level number.  We don't reuse Task.save()'s WBS logic
        # because inbound tasks always land in the project's flat backlog
        # area — they aren't part of the PM's planned WBS structure unless
        # they have a resolved parent.
        if parent_wbs is not None:
            # Count direct children of the parent (one segment deeper, e.g. "1.2.X"
            # for parent "1.2") via a regex that matches the exact depth.  The
            # earlier startswith+exclude version was broken — `wbs_path__contains="."`
            # was true for every multi-segment path, so it never excluded anything.
            # Scope is project_id+regex; the project_id filter is indexed so the
            # regex runs only over this project's tasks.
            import re

            escaped = re.escape(parent_wbs)
            child_pattern = rf"^{escaped}\.[^.]+$"
            child_count = Task.objects.filter(
                project=project,
                wbs_path__regex=child_pattern,
                is_deleted=False,
            ).count()
            wbs_path = f"{parent_wbs}.{child_count + 1}"
            is_subtask = True
        else:
            wbs_path = None  # let Task.save() leave WBS unset; backlog tasks don't need a path
            is_subtask = False

        task = Task.objects.create(
            project=project,
            name=name[:512],
            assignee=assignee_user,
            status=status_value,
            story_points=story_points,
            wbs_path=wbs_path,
            is_subtask=is_subtask,
            notes=description,
        )
        link = InboundTaskLink.objects.create(
            project=project,
            task=task,
            source=source,
            external_id=external_id,
            external_url=external_url,
            parent_external_id=parent_external_id,
            pending_assignee_email=pending_email,
            created_via_token=token,
            last_synced_via_token=token,
        )
    else:
        # link is guaranteed non-None on this branch (created is False); narrow
        # the type for mypy.
        assert link is not None
        task = link.task
        # Write-through fields — overwritten on every push.  Use bulk UPDATE
        # so we increment server_version exactly once and avoid the
        # status_changed_at side effect (Task.save() resets it on status
        # transition; we want to preserve "when status flipped in the external
        # system" semantics, not "when the webhook arrived").
        new_status = status_value
        update_fields: dict[str, Any] = {
            "name": name[:512],
            "notes": description,
            "story_points": story_points,
            "server_version": F("server_version") + 1,
        }
        # Only set assignee on resolve — never overwrite an existing assignment.
        if task.assignee_id is None and assignee_user is not None:
            update_fields["assignee"] = assignee_user
        if task.status != new_status:
            update_fields["status"] = new_status
            from django.utils import timezone as _tz

            update_fields["status_changed_at"] = _tz.now()
        Task.objects.filter(pk=task.pk).update(**update_fields)
        # Refresh task to get post-update field values for downstream callers.
        task.refresh_from_db()

        # Link row updates: refresh URL + last_synced_via_token, clear
        # pending_assignee_email if we just resolved it.
        link.external_url = external_url
        link.last_synced_via_token = token
        if assignee_user is not None and link.pending_assignee_email == assignee_email:
            link.pending_assignee_email = None
        link.save()

    # Audit row — same transaction; survives even if downstream broadcast fails.
    ApiTokenAuditEntry.objects.create(
        project=project,
        token=token,
        token_prefix=token.token_prefix,
        actor=None,  # inbound use; no Django user
        action=ApiTokenAuditAction.USED.value,
        source_ip=source_ip,
        detail={
            "source": source,
            "external_id": external_id,
            "created": created,
            "assignee_resolved": assignee_user is not None,
        },
    )

    project_id = str(project.pk)
    task_id = str(task.pk)
    event_type = "task_created" if created else "task_updated"
    webhook_event = "task.created" if created else "task.updated"
    webhook_payload = {
        "id": task_id,
        "short_id": task.short_id,
        "name": task.name,
        "status": task.status,
        "source": source,  # X-Source semantics per ADR-0065 addendum
    }

    # Bind each lambda's captured values via default arguments so closure
    # late-binding can never substitute a different value if this function
    # is extended later to register multiple branches per call.
    def _recalc(pid: str = project_id) -> None:
        _enqueue_recalculate(pid)

    def _broadcast(
        pid: str = project_id, et: str = event_type, tid: str = task_id, src: str = source
    ) -> None:
        broadcast_board_event(pid, et, {"id": tid, "source": src})

    def _dispatch(
        pid: str = project_id,
        we: str = webhook_event,
        wp: dict[str, Any] = webhook_payload,
    ) -> None:
        dispatch_webhooks(pid, we, wp)

    transaction.on_commit(_recalc)
    transaction.on_commit(_broadcast)
    transaction.on_commit(_dispatch)

    # link is non-None on both create and update branches by construction.
    assert link is not None
    return UpsertResult(
        task=task,
        link=link,
        created=created,
        assignee_resolved=assignee_user is not None,
    )
