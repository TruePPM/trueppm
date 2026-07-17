"""Match a verified Git webhook to a task and move its card (#329, ADR-0158).

The service is the second half of the OSS Git-event automation: given an already
**verified** :class:`~trueppm_api.apps.integrations.git_webhook_auth.GitWebhookEnvelope`,
it finds the task that carries the PR/MR as a ``TaskLink`` and advances that card's
board status **forward only** through the canonical ``TaskSerializer`` write path.

Three deliberate properties (all enforced here, none bypassable):

- **Forward-only.** ``pr.opened`` moves a card to REVIEW only from
  ``{BACKLOG, NOT_STARTED, IN_PROGRESS}``; ``pr.merged`` moves to COMPLETE only
  from a non-COMPLETE state. A card already at/ahead of the target is a no-op —
  automation never drags a card backward, and a redelivered webhook is idempotent
  even if the Redis dedup layer is unavailable.
- **No parallel transition path.** The status write goes through ``TaskSerializer``
  exactly as a human board drag would, so every existing validation, actual-date
  rule (ADR-0136), and the advisory WIP surface (ADR-0039) apply unchanged. The
  automation neither adds nor circumvents a hard WIP block (there is none).
- **Attributed but classified as automation.** The write is attributed to the
  configuring admin (``configured_by``) for RBAC + history, while
  ``history_change_reason`` tags it ``git:pr_*`` so the ADR-0096 activity timeline
  shows it as an automated move, and the WS broadcast carries ``actor_id=None``
  (ADR-0152 system write).
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from django.db import transaction

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.models import Task, TaskStatus

from .git_webhook_auth import GIT_EVENT_PR_MERGED, GIT_EVENT_PR_OPENED, PROVIDER_GITHUB
from .models import BoardAutomation, TaskLink
from .providers import _parse_github_url, _parse_gitlab_url

if TYPE_CHECKING:
    from django.contrib.auth.models import AbstractBaseUser

# pr.opened may advance a card to REVIEW only from these states — never from
# REVIEW or COMPLETE (forward-only). pr.merged may advance to COMPLETE from any
# non-COMPLETE state.
_PR_OPENED_SOURCE_STATES = frozenset(
    {TaskStatus.BACKLOG, TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS}
)

_CHANGE_REASON = {
    GIT_EVENT_PR_OPENED: "git:pr_opened",
    GIT_EVENT_PR_MERGED: "git:pr_merged",
}


@dataclass(frozen=True)
class GitAutomationResult:
    """Outcome of applying one webhook, shaped for the receiver's JSON response."""

    matched: bool
    moved: bool
    task_id: str | None = None
    from_status: str | None = None
    to_status: str | None = None
    reason: str = ""


class _SystemRequest:
    """Minimal request stand-in for the serializer's ``context["request"]``.

    The ``TaskSerializer`` only reads ``request.user`` (for role/history); a full
    DRF request is unnecessary and would drag in middleware. ``caller_role`` is
    passed alongside in context so role resolution never hits the DB for a user
    who may since have been removed from the project.
    """

    def __init__(self, user: AbstractBaseUser | None) -> None:
        self.user = user
        self.method = "PATCH"


def _pr_key(provider: str, url: str) -> tuple[Any, ...] | None:
    """Parse a PR/MR URL into a comparable identity tuple, or ``None``.

    Reuses the existing ``providers`` parsers. For GitHub the resource must be a
    ``pull`` (issues share the URL shape but are not board-moving PRs); for GitLab
    the parser already restricts to ``merge_requests``/``issues`` and we keep only
    merge requests.
    """
    # Both providers return a ``(repo_path, ref)`` pair so the tuple shape is
    # identical regardless of provider (GitHub owner/repo is folded into one
    # path segment, mirroring GitLab's already-combined project path).
    if provider == PROVIDER_GITHUB:
        parsed = _parse_github_url(url)
        if parsed is None:
            return None
        owner, repo, kind, ref = parsed
        if kind != "pull":
            return None
        return (f"{owner.lower()}/{repo.lower()}", ref)
    parsed_gl = _parse_gitlab_url(url)
    if parsed_gl is None:
        return None
    project_path, kind, ref = parsed_gl
    if kind != "merge_requests":
        return None
    return (project_path.lower(), ref)


def _find_linked_task(project_id: Any, provider: str, pr_url: str) -> Task | None:
    """Find the project task whose ``TaskLink`` points at ``pr_url``.

    No normalized URL column exists (ADR-0158 §4), so this is parse-and-compare,
    bounded to the project's own links — the candidate set is small. The first
    matching link wins; a task linked to the same PR more than once is degenerate.
    """
    target = _pr_key(provider, pr_url)
    if target is None:
        return None
    candidates = (
        TaskLink.objects.filter(
            task__project_id=project_id,
            is_deleted=False,
            task__is_deleted=False,
        )
        .select_related("task")
        .only("url", "task")
    )
    for link in candidates:
        if _pr_key(provider, link.url) == target:
            return link.task
    return None


def _target_status(event: str, current: str) -> str | None:
    """Resolve the forward-only target board status, or ``None`` for a no-op."""
    if event == GIT_EVENT_PR_OPENED:
        return TaskStatus.REVIEW if current in _PR_OPENED_SOURCE_STATES else None
    if event == GIT_EVENT_PR_MERGED:
        return TaskStatus.COMPLETE if current != TaskStatus.COMPLETE else None
    return None


def apply_git_event_to_card(
    automation: BoardAutomation, provider: str, event: str, pr_url: str | None
) -> GitAutomationResult:
    """Apply one verified Git event to its linked card.

    Args:
        automation: the enabled ``BoardAutomation`` for the target project.
        provider: ``"github"`` / ``"gitlab"`` (from the verified envelope).
        event: ``pr.opened`` / ``pr.merged``.
        pr_url: the PR/MR URL from the payload.

    Returns:
        A :class:`GitAutomationResult` describing what happened. Always a 200-shaped
        result — "no link" and "already there" are normal, not errors.
    """
    if not pr_url:
        return GitAutomationResult(matched=False, moved=False, reason="no_url")

    task = _find_linked_task(automation.project_id, provider, pr_url)
    if task is None:
        return GitAutomationResult(matched=False, moved=False, reason="no_link")

    current = task.status
    target = _target_status(event, current)
    if target is None:
        # Forward-only no-op: the card is already at or ahead of the target.
        return GitAutomationResult(
            matched=True,
            moved=False,
            task_id=str(task.pk),
            from_status=current,
            to_status=current,
            reason="noop_forward_only",
        )

    moved_task = _write_status(task, target, event, automation.configured_by)
    return GitAutomationResult(
        matched=True,
        moved=True,
        task_id=str(moved_task.pk),
        from_status=current,
        to_status=target,
        reason="opened_review" if event == GIT_EVENT_PR_OPENED else "merged_complete",
    )


def _write_status(task: Task, target: str, event: str, actor: AbstractBaseUser | None) -> Task:
    """Write the new status through the canonical serializer + broadcast the move.

    Runs inside ``transaction.atomic`` so the status write and the deferred
    broadcast commit together. ``_change_reason`` / ``_history_user`` are stamped
    on the instance before ``save()`` so ``django-simple-history`` attributes the
    edit to the configuring admin and classifies it as automation (ADR-0096).
    """
    # Imported lazily — the projects serializer module is heavy and importing it
    # at module load would create an apps-not-ready risk during migrations.
    from trueppm_api.apps.projects.serializers import TaskSerializer
    from trueppm_api.apps.sync.broadcast import broadcast_task_updated

    with transaction.atomic():
        task._change_reason = _CHANGE_REASON[event]  # type: ignore[attr-defined]
        task._history_user = actor  # type: ignore[attr-defined]
        serializer = TaskSerializer(
            instance=task,
            data={"status": target},
            partial=True,
            context={"request": _SystemRequest(actor), "caller_role": Role.ADMIN},
        )
        serializer.is_valid(raise_exception=True)
        updated: Task = serializer.save()

        project_id_str = str(updated.project_id)
        task_id_str = str(updated.pk)
        version = updated.server_version
        # actor_id=None — automation/system write (ADR-0152). Deferred to commit
        # so a connected board refreshes the card without a manual refetch.
        transaction.on_commit(
            functools.partial(
                broadcast_task_updated,
                project_id_str,
                task_id=task_id_str,
                changed_fields=["status"],
                version=version,
                actor_id=None,
            )
        )
    return updated
