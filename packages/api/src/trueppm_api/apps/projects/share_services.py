"""Service layer for public read-only board share links (#283, ADR-0245).

Keeps token hashing, minimization, and access metering in one auditable place so
the views stay thin. Token handling mirrors the ``ApiToken`` / ``WorkspaceInvite``
lineage: the raw token is returned once at mint and only its SHA-256 hash is
persisted; lookup is O(1) on the unique hash index.
"""

from __future__ import annotations

import logging
import secrets
from typing import Any

from django.conf import settings
from django.db.models import F
from django.utils import timezone

from trueppm_api.apps.projects.authentication import sha256_hex
from trueppm_api.apps.projects.models import (
    BoardColumnConfig,
    Dependency,
    ShareContentKind,
    ShareLink,
    Task,
    TaskStatus,
)
from trueppm_api.apps.workspace.serializers import display_name_for

logger = logging.getLogger(__name__)

# The board columns shown publicly when a project has no custom BoardColumnConfig:
# the standard non-backlog workflow lane, in order. Backlog is deliberately never
# published (ADR-0245) — a shared board is a delivery-status surface, not the intake
# pool, and unrefined backlog items are the most likely to carry sensitive names.
_PUBLIC_DEFAULT_STATUSES = (
    TaskStatus.NOT_STARTED,
    TaskStatus.IN_PROGRESS,
    TaskStatus.REVIEW,
    TaskStatus.COMPLETE,
)


def mint_share_link(
    project: Any,
    user: Any,
    *,
    label: str = "",
    show_assignees: bool = False,
    content_kind: str = ShareContentKind.BOARD,
    expires_at: Any = None,
) -> tuple[ShareLink, str]:
    """Create a share link and return ``(link, raw_token)``.

    The raw token is non-enumerable (``secrets.token_urlsafe(32)`` ≈ 256 bits) and
    is returned exactly once — only its hash is stored, so it can never be
    retrieved again. ``expires_at`` (optional, #1486) auto-expires the link — after
    it passes, the public endpoint returns 410 exactly like a revoked link.
    """
    raw = secrets.token_urlsafe(32)
    link = ShareLink.objects.create(
        project=project,
        content_kind=content_kind,
        token_prefix=raw[:12],
        token_hash=sha256_hex(raw),
        label=label,
        show_assignees=show_assignees,
        expires_at=expires_at,
        created_by=user if getattr(user, "is_authenticated", False) else None,
    )
    logger.info(
        "share_link.minted id=%s project=%s kind=%s by=%s",
        link.id,
        project.id,
        content_kind,
        getattr(user, "id", None),
    )
    return link, raw


def revoke_share_link(link: ShareLink, user: Any) -> None:
    """Soft-revoke a link. Idempotent — re-revoking an already-revoked link is a no-op."""
    if link.revoked_at is not None:
        return
    link.revoked_at = timezone.now()
    link.revoked_by = user if getattr(user, "is_authenticated", False) else None
    link.save(update_fields=["revoked_at", "revoked_by"])
    logger.info(
        "share_link.revoked id=%s project=%s by=%s",
        link.id,
        link.project_id,
        getattr(user, "id", None),
    )


def resolve_share_link(token: str, content_kind: str) -> ShareLink | None:
    """Return the ``ShareLink`` for a raw token (active *or* revoked), or ``None``.

    Looks up by SHA-256 hash — O(1) on the unique index, no per-row compare, so
    there is no timing-oracle to enumerate against. Filtered on ``content_kind`` so
    a board token can never resolve a schedule view (forward-compat for #1486). The
    caller distinguishes revoked (→ 410) from unknown (``None`` → 404).
    """
    if not token:
        return None
    return (
        ShareLink.objects.filter(token_hash=sha256_hex(token), content_kind=content_kind)
        .select_related("project")
        .first()
    )


def record_access(link: ShareLink) -> None:
    """Bump the access meter with a single atomic UPDATE (no ``save()``, no history).

    Mirrors ``ApiToken.last_used_at``. An ``F()`` increment is retry-safe; a rare
    double-count on a client retry is acceptable for a view meter.
    """
    ShareLink.objects.filter(pk=link.pk).update(
        access_count=F("access_count") + 1,
        last_accessed_at=timezone.now(),
    )


def _public_columns(project: Any) -> list[dict[str, str]]:
    """Ordered ``[{key, label}]`` columns to publish (config order, backlog excluded)."""
    try:
        config = BoardColumnConfig.objects.get(project=project)
        cols = config.columns or None
    except BoardColumnConfig.DoesNotExist:
        cols = None
    if cols:
        return [
            {"key": c["status"], "label": c.get("label") or c["status"].replace("_", " ").title()}
            for c in cols
            if c.get("visible", True) and c["status"] != TaskStatus.BACKLOG.value
        ]
    return [{"key": s.value, "label": s.label} for s in _PUBLIC_DEFAULT_STATUSES]


def _public_card(task: Task, show_assignees: bool) -> dict[str, Any]:
    """Minimized, whitelisted card. Comments/notes/attachments/points are never emitted."""
    due = task.early_finish or task.planned_start
    card: dict[str, Any] = {
        "short_id": task.short_id,
        "name": task.name,
        "status": task.status,
        "is_milestone": task.is_milestone,
        "percent_complete": task.percent_complete,
        "due_date": due.isoformat() if due else None,
        "assignee": None,
    }
    # Assignee identity is opt-in only (ADR-0245): a display name, never email/id/avatar.
    assignee = task.assignee
    if show_assignees and assignee is not None:
        card["assignee"] = display_name_for(
            assignee.first_name, assignee.last_name, assignee.username
        )
    return card


def serialize_public_board(link: ShareLink) -> dict[str, Any]:
    """Build the minimized, bounded public board snapshot for ``link``.

    Excludes soft-deleted tasks and the backlog column; caps the payload at
    ``SHARE_BOARD_MAX_CARDS`` and flags ``truncated`` rather than silently dropping
    cards.
    """
    project = link.project
    columns = _public_columns(project)
    visible_statuses = [c["key"] for c in columns]
    cap = int(getattr(settings, "SHARE_BOARD_MAX_CARDS", 1000))

    qs = (
        Task.objects.filter(
            project=project,
            is_deleted=False,
            status__in=visible_statuses,
        )
        .select_related("assignee")
        .order_by("status", "priority_rank", "name")
    )
    rows = list(qs[: cap + 1])
    truncated = len(rows) > cap
    rows = rows[:cap]

    by_status: dict[str, list[dict[str, Any]]] = {c["key"]: [] for c in columns}
    for task in rows:
        by_status.setdefault(task.status, []).append(_public_card(task, link.show_assignees))

    return {
        "content_kind": link.content_kind,
        "project": {"name": project.name, "short_id": project.code or ""},
        "columns": [
            {"key": c["key"], "label": c["label"], "cards": by_status.get(c["key"], [])}
            for c in columns
        ],
        "show_assignees": link.show_assignees,
        "truncated": truncated,
    }


def _public_schedule_task(task: Task, show_assignees: bool) -> dict[str, Any]:
    """Minimized, whitelisted schedule row for the public timeline (#1486, ADR-0265).

    Emits ONLY what a read-only Gantt needs to draw bars, structure, and the
    critical path. Internal slack intelligence (``late_start``/``late_finish``/
    ``total_float``/``free_float``), PERT/Monte Carlo durations and percentiles,
    baseline overlay, cost, resource units, priority, and blocker fields are
    excluded by omission — criticality is surfaced via the boolean ``is_critical``
    flag, never the raw float. Assignee identity is opt-in only (a display name,
    never email/id/avatar), matching the board projection.
    """
    row: dict[str, Any] = {
        "short_id": task.short_id,
        "name": task.name,
        # ltree value coerces to str ("1.2.3") for indent / summary structure.
        "wbs_path": str(task.wbs_path) if task.wbs_path else "",
        "duration": task.duration,
        "planned_start": task.planned_start.isoformat() if task.planned_start else None,
        "early_start": task.early_start.isoformat() if task.early_start else None,
        "early_finish": task.early_finish.isoformat() if task.early_finish else None,
        "is_milestone": task.is_milestone,
        "is_critical": bool(task.is_critical),
        "percent_complete": task.percent_complete,
        "status": task.status,
        "assignee": None,
    }
    assignee = task.assignee
    if show_assignees and assignee is not None:
        row["assignee"] = display_name_for(
            assignee.first_name, assignee.last_name, assignee.username
        )
    return row


def serialize_public_schedule(link: ShareLink) -> dict[str, Any]:
    """Build the minimized, bounded public schedule snapshot for ``link`` (#1486).

    Mirrors :func:`serialize_public_board`: excludes soft-deleted tasks, caps the
    payload at ``SHARE_SCHEDULE_MAX_TASKS`` (flagging ``truncated`` rather than
    silently dropping), and emits dependency edges by ``short_id`` (never task
    UUIDs) so the read-only renderer can draw links. All internal risk/float
    intelligence is withheld — see :func:`_public_schedule_task`.
    """
    project = link.project
    cap = int(getattr(settings, "SHARE_SCHEDULE_MAX_TASKS", 1000))

    # Exclude the backlog exactly as the board projection does (ADR-0245): the
    # intake pool is un-triaged and the most likely to carry sensitive raw names, so
    # a shared schedule is a delivery-status surface, not the backlog. Backlog tasks
    # are unscheduled anyway and would only render as "Unscheduled" noise.
    qs = (
        Task.objects.filter(project=project, is_deleted=False)
        .exclude(status=TaskStatus.BACKLOG)
        .select_related("assignee")
        .order_by("wbs_path", "early_start", "name")
    )
    rows = list(qs[: cap + 1])
    truncated = len(rows) > cap
    rows = rows[:cap]

    published_ids = {task.id for task in rows}
    tasks = [_public_schedule_task(task, link.show_assignees) for task in rows]

    # One query for edges, both endpoints among the published (non-deleted) tasks,
    # then map ids → short_ids in Python — no per-task/per-edge N+1. Edges to a
    # task that was truncated away or soft-deleted are dropped so no dangling arrow
    # is ever emitted.
    id_to_short = {task.id: task.short_id for task in rows}
    dependencies: list[dict[str, Any]] = []
    # Bound the edge query to the published (capped, non-deleted) task set in SQL, so
    # a project with far more edges than the task cap can't return rows we'd only
    # discard in Python. The membership re-check below is then a no-op safety net.
    edge_qs = Dependency.objects.filter(
        is_deleted=False,
        predecessor_id__in=published_ids,
        successor_id__in=published_ids,
    ).values_list("predecessor_id", "successor_id", "dep_type", "lag")
    for pred_id, succ_id, dep_type, lag in edge_qs:
        if pred_id in published_ids and succ_id in published_ids:
            dependencies.append(
                {
                    "predecessor_short_id": id_to_short[pred_id],
                    "successor_short_id": id_to_short[succ_id],
                    "dep_type": dep_type,
                    "lag": lag,
                }
            )

    return {
        "content_kind": link.content_kind,
        "project": {"name": project.name, "short_id": project.code or ""},
        "tasks": tasks,
        "dependencies": dependencies,
        "show_assignees": link.show_assignees,
        "truncated": truncated,
    }
