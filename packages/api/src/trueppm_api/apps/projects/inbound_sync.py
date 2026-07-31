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
from simple_history.utils import get_history_manager_for_model

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


@dataclass(frozen=True)
class _Resolved:
    """One inbound payload, normalized and resolved against the project.

    Everything here is derived before the ``select_for_update()`` row lock is
    taken, so the create and update branches operate on identical values and
    neither needs the raw payload.  ``pending_email`` is the assignee address
    that did *not* resolve to a project member — kept on the link row so a later
    push (or an invite acceptance) can complete the assignment.
    """

    source: str
    external_id: str
    name: str
    description: str
    story_points: int | None
    external_url: str | None
    parent_external_id: str | None
    assignee_email: str | None
    status: str
    assignee: Any | None
    pending_email: str | None
    parent_wbs: str | None


def _resolve_payload(
    project: Project, token: ProjectApiToken, payload: dict[str, Any]
) -> _Resolved:
    """Normalize the payload and resolve status, assignee, and parent WBS."""
    source = payload["source"]
    external_id = payload["external_id"]
    parent_external_id = payload.get("parent_external_id") or None
    assignee_email = payload.get("assignee_email") or None
    assignee_user, pending_email = _resolve_assignee(assignee_email, project)
    return _Resolved(
        source=source,
        external_id=external_id,
        name=payload.get("name") or external_id,  # name is recommended but not required
        description=payload.get("description") or "",
        story_points=payload.get("story_points"),
        external_url=payload.get("external_url") or None,
        parent_external_id=parent_external_id,
        assignee_email=assignee_email,
        status=_resolve_status(payload.get("status"), token),
        assignee=assignee_user,
        pending_email=pending_email,
        parent_wbs=_resolve_parent_wbs(project, source, parent_external_id),
    )


def _allocate_wbs(project: Project, parent_wbs: str | None) -> tuple[str | None, bool]:
    """Pick the WBS path for a newly-created inbound task.

    We don't reuse ``Task.save()``'s WBS logic because inbound tasks always land
    in the project's flat backlog area — they aren't part of the PM's planned WBS
    structure unless they have a resolved parent.
    """
    if parent_wbs is None:
        # Let Task.save() leave WBS unset; backlog tasks don't need a path.
        return None, False

    # Count direct children of the parent (one segment deeper, e.g. "1.2.X"
    # for parent "1.2") via a regex that matches the exact depth.  The
    # earlier startswith+exclude version was broken — `wbs_path__contains="."`
    # was true for every multi-segment path, so it never excluded anything.
    # Scope is project_id+regex; the project_id filter is indexed so the
    # regex runs only over this project's tasks.
    import re

    child_pattern = rf"^{re.escape(parent_wbs)}\.[^.]+$"
    child_count = Task.objects.filter(
        project=project,
        wbs_path__regex=child_pattern,
        is_deleted=False,
    ).count()
    return f"{parent_wbs}.{child_count + 1}", True


def _create_inbound_task(
    project: Project, token: ProjectApiToken, resolved: _Resolved
) -> tuple[Task, InboundTaskLink]:
    """Create the Task and its link row for a first-time external id."""
    wbs_path, is_subtask = _allocate_wbs(project, resolved.parent_wbs)

    # Hybrid-by-construction note (#1665): this agent write path creates only
    # Tasks — never Dependency edges — so there is no dependency graph to
    # validate here and the shared cycle/self-reference guard
    # (scheduling.graph_guard.validate_task_graph) is vacuous. If inbound sync
    # ever grows dependency writes, route the proposed edges through that guard
    # before persisting, exactly as the offline importer (#1664) does, so an
    # agent principal is governed identically to the human write path.
    task = Task.objects.create(
        project=project,
        name=resolved.name[:512],
        assignee=resolved.assignee,
        status=resolved.status,
        story_points=resolved.story_points,
        wbs_path=wbs_path,
        is_subtask=is_subtask,
        notes=resolved.description,
    )
    link = InboundTaskLink.objects.create(
        project=project,
        task=task,
        source=resolved.source,
        external_id=resolved.external_id,
        external_url=resolved.external_url,
        parent_external_id=resolved.parent_external_id,
        pending_assignee_email=resolved.pending_email,
        created_via_token=token,
        last_synced_via_token=token,
    )
    return task, link


def _status_transition_fields(
    task: Task, old_status: str, new_status: str, story_points: int | None
) -> dict[str, Any]:
    """Re-apply the actual-date / percent coercions the bulk UPDATE bypasses.

    ``Task.save()`` and ``TaskSerializer.update()`` perform these on the REST
    path; the write-through ``.update()`` below skips both (#1767). Without them,
    a task marked "Done" by an external system lands in the Done column at 0%
    with no actual dates — EVM/burndown under-count it.
    """
    from django.utils import timezone as _tz

    today = _tz.localdate()
    fields: dict[str, Any] = {"status": new_status, "status_changed_at": _tz.now()}

    if old_status == TaskStatus.COMPLETE.value:
        # Reopened from COMPLETE — clear the finish stamp and restore
        # remaining effort from the commitment baseline (the COMPLETE
        # transition zeroed it). Mirrors TaskSerializer.update(). Uses the
        # story_points being written on this push (falls back to the stored
        # value) so burndown counts the reopened work again.
        fields["actual_finish"] = None
        fields["remaining_points"] = story_points if story_points is not None else task.story_points
    if new_status == TaskStatus.IN_PROGRESS.value and task.actual_start is None:
        fields["actual_start"] = today
    elif new_status == TaskStatus.COMPLETE.value:
        if task.actual_finish is None:
            fields["actual_finish"] = today
        fields["remaining_points"] = 0
    if new_status in (TaskStatus.REVIEW.value, TaskStatus.COMPLETE.value):
        fields["percent_complete"] = 100.0
    return fields


def _update_inbound_task(
    link: InboundTaskLink, token: ProjectApiToken, resolved: _Resolved
) -> Task:
    """Write through the mutable fields onto an already-linked task.

    Uses a bulk UPDATE so we increment ``server_version`` exactly once and avoid
    the ``status_changed_at`` side effect (``Task.save()`` resets it on a status
    transition; we want "when status flipped in the external system", not "when
    the webhook arrived").
    """
    task = link.task
    old_status = task.status
    new_status = resolved.status
    status_changed = old_status != new_status

    # The bulk UPDATE bypasses VersionedModel.save(), so the sync delta cursor
    # must be drawn explicitly — otherwise this write moves server_version but
    # not sync_seq, and the row stays below the project's checkpoint and is never
    # delivered to an offline client (ADR-0686).
    from trueppm_api.apps.sync.sequence import allocate_for_projects

    update_fields: dict[str, Any] = {
        "name": resolved.name[:512],
        "notes": resolved.description,
        "story_points": resolved.story_points,
        "server_version": F("server_version") + 1,
        "sync_seq": allocate_for_projects([task.project_id]),
    }
    # Only set assignee on resolve — never overwrite an existing assignment.
    if task.assignee_id is None and resolved.assignee is not None:
        update_fields["assignee"] = resolved.assignee
    if status_changed:
        update_fields.update(
            _status_transition_fields(task, old_status, new_status, resolved.story_points)
        )
    Task.objects.filter(pk=task.pk).update(**update_fields)
    # Refresh task to get post-update field values for downstream callers.
    task.refresh_from_db()

    # The bulk .update() above is deliberate (single server_version bump,
    # externally-supplied status_changed_at preserved — see the write-through
    # docstring), but it also bypasses django-simple-history's post_save
    # receiver, so without this no HistoricalTask row is written and
    # external-system/agent edits are invisible in every activity/history
    # surface (#1876). Record the post-update state explicitly through
    # simple_history's own bulk machinery (the same path
    # bulk_update_with_history uses): it respects the model's
    # excluded_fields and only INSERTs a history row — the task row itself
    # is untouched, so server_version is not double-bumped and
    # status_changed_at keeps its .update() semantics. history_user resolves
    # through simple_history's middleware context to request.user, which
    # ProjectApiTokenAuthentication sets to token.created_by — identical to
    # the attribution the create branch's post_save "+" row already gets
    # (and None outside a request). The change reason carries the external
    # source tag so the feed can tell an inbound edit from a direct one.
    get_history_manager_for_model(Task).bulk_history_create(
        [task],
        update=True,
        default_change_reason=f"inbound sync: {resolved.source}",
    )

    if status_changed:
        # task_status_changed is the OSS extension point Task.save() emits on a
        # status transition — it drives real-time burndown upserts today and is
        # the documented hook other OSS/Enterprise receivers register against.
        # The bulk .update() above skips it, so fire it explicitly here (#1767).
        # send_robust: a raising third-party/Enterprise receiver must never
        # propagate out of and break this OSS write path (mirrors Task.save()).
        from trueppm_api.apps.projects.signals import task_status_changed
        from trueppm_api.core.extension_signals import dispatch_extension_signal

        dispatch_extension_signal(
            task_status_changed,
            sender=Task,
            task=task,
            old_status=old_status,
            new_status=new_status,
        )

    # Link row updates: refresh URL + last_synced_via_token, clear
    # pending_assignee_email if we just resolved it.
    link.external_url = resolved.external_url
    link.last_synced_via_token = token
    if resolved.assignee is not None and link.pending_assignee_email == resolved.assignee_email:
        link.pending_assignee_email = None
    link.save()
    return task


def _defer_side_effects(
    project: Project, task: Task, resolved: _Resolved, *, created: bool
) -> None:
    """Queue the post-commit CPM recalc, board broadcast, and webhook dispatch."""
    from trueppm_api.apps.scheduling.services import (
        enqueue_recalculate as _enqueue_recalculate,
    )
    from trueppm_api.apps.sync.broadcast import broadcast_board_event
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    project_id = str(project.pk)
    task_id = str(task.pk)
    event_type = "task_created" if created else "task_updated"
    webhook_event = "task.created" if created else "task.updated"
    webhook_payload = {
        "id": task_id,
        "short_id": task.short_id,
        "name": task.name,
        "status": task.status,
        "source": resolved.source,  # X-Source semantics per ADR-0065 addendum
    }

    # Bind each lambda's captured values via default arguments so closure
    # late-binding can never substitute a different value if this function
    # is extended later to register multiple branches per call.
    def _recalc(pid: str = project_id) -> None:
        _enqueue_recalculate(pid)

    def _broadcast(
        pid: str = project_id, et: str = event_type, tid: str = task_id, src: str = resolved.source
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
        # No secret logged: token.token_prefix is the short non-secret identifier
        # prefix (the full token value is never read here), plus status strings.
        # nosemgrep: python-logger-credential-disclosure
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
    resolved = _resolve_payload(project, token, payload)

    link = (
        InboundTaskLink.objects.select_for_update()
        .select_related("task")
        .filter(
            project=project,
            source=resolved.source,
            external_id=resolved.external_id,
            is_deleted=False,
        )
        .first()
    )

    created = link is None
    if link is None:
        task, link = _create_inbound_task(project, token, resolved)
    else:
        task = _update_inbound_task(link, token, resolved)

    # Audit row — same transaction; survives even if downstream broadcast fails.
    ApiTokenAuditEntry.objects.create(
        project=project,
        token=token,
        token_prefix=token.token_prefix,
        actor=None,  # inbound use; no Django user
        action=ApiTokenAuditAction.USED.value,
        source_ip=source_ip,
        detail={
            "source": resolved.source,
            "external_id": resolved.external_id,
            "created": created,
            "assignee_resolved": resolved.assignee is not None,
        },
    )

    _defer_side_effects(project, task, resolved, created=created)

    return UpsertResult(
        task=task,
        link=link,
        created=created,
        assignee_resolved=resolved.assignee is not None,
    )
