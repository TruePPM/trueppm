"""Structured-blocker service layer (ADR-0124, #1135/#1134/#1125).

The organizing principle of the blocker wave is a privacy split:

* ``blocker_type`` + age (``blocked_since``) + actor (``blocked_by``) +
  ``blocking_task`` are the **team-shareable, queryable, routable** triage signal.
* ``blocked_reason`` (free text) is **PRIVATE** — visible only to the task's
  assignee and the users @-mentioned on it. It is contributor voice and must
  NEVER become a filterable/queryable PM-surveillance field (Morgan's hard-NO).

This module is the single source of truth for that boundary:

* :func:`can_read_blocker_reason` — the one authorization predicate every read
  surface (the task serializer, both roll-ups, the standup) consults.
* :func:`resolve_impediment_recipients` — the SM/PM recipient resolver for the
  ``task.blocked`` notification (#1134).
* :func:`blocked_age_seconds` / :func:`project_blocked_rollup` /
  :func:`sprint_blocked_rollup` — the read-only roll-up endpoints, none of which
  carry reason text.

Keeping the gate in one helper (rather than re-deriving the predicate at each
surface) is the mitigation for the highest-rated risk in the ADR: a reason leak
through any one inconsistent surface.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from django.contrib.auth.models import AbstractBaseUser

    from trueppm_api.apps.projects.models import Task


def can_read_blocker_reason(task: Task, user: AbstractBaseUser | None) -> bool:
    """Return whether ``user`` may read ``task.blocked_reason`` (the private free text).

    The reason text is contributor voice. Only two parties may read it:

    1. the task's **assignee** (it is their own blocker), and
    2. any user **@-mentioned on the task** (they were explicitly looped in).

    Everyone else — including the PM, the Scrum Master, and any other project
    member — gets the structured signal (type/age/actor/link) but never the
    reason. This is the Morgan surveillance boundary; it is enforced here once
    and consulted by every read surface so there is no divergent second copy.

    A ``None`` / unauthenticated user can never read the reason.

    Args:
        task: The blocked task whose reason visibility is being decided.
        user: The requesting user (``request.user``), or ``None``.

    Returns:
        ``True`` iff the reason text may be included in the response for this user.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return False

    # The assignee owns the blocker — they always see their own reason.
    if task.assignee_id is not None and str(task.assignee_id) == str(user.pk):
        return True

    # @-mentioned on the task: a Mention whose source comment is on this task and
    # whose ``mentioned_user`` is the requester. Today the only mention source is
    # ``task_comment`` (a future ``task_note`` source — #476 — would widen this).
    from trueppm_api.apps.notifications.models import Mention

    return Mention.objects.filter(
        task_comment__task_id=task.pk,
        mentioned_user_id=user.pk,
    ).exists()


def blocked_age_seconds(task_blocked_since: Any) -> int | None:
    """Return the integer seconds a task has been blocked, or ``None`` if not blocked.

    Age (not the reason) is the escalation signal: an impediment open for two days
    routes differently than one open for ten minutes. Derived from
    ``blocked_since`` (stamped in ``Task.save()`` on the flag transition). Clamped
    at zero so a clock skew can never produce a negative age.

    Args:
        task_blocked_since: The ``blocked_since`` datetime, or ``None``.

    Returns:
        Whole seconds since the task was flagged, ``None`` when ``blocked_since``
        is unset (the task is not flagged blocked).
    """
    if task_blocked_since is None:
        return None
    from django.utils import timezone

    delta = timezone.now() - task_blocked_since
    return max(0, int(delta.total_seconds()))


def resolve_impediment_recipients(task: Task) -> set[Any]:
    """Resolve the user PKs that should be notified a task was flagged blocked (#1134).

    Bridges project → team → facet (ADR-0078) and project → role (the access
    matrix) to reach the people whose job is to clear impediments:

    * the **assignee** (the owner of the blocked work — existing behavior), plus
    * every **Scrum Master** (``TeamMembership.is_scrum_master``) on the task's
      project's teams, plus
    * every **PM** — a project membership with ``role >= Role.ADMIN``.

    The actor who raised the flag is intentionally NOT excluded here: a Scrum
    Master or PM who flags someone else's task still wants the assignee notified,
    and the assignee-vs-actor exclusion is applied separately at the call site for
    the assignee path only (preserving the existing "notify assignee, not actor"
    contract). De-duped across all three sources.

    If a project has no team / no SM facet set, the resolver still returns the
    PM(s) — so a blocker always reaches someone who can act (ADR-0124 §Risks).

    Args:
        task: The task that was just flagged blocked.

    Returns:
        A de-duplicated set of user PKs to notify, gated downstream by each
        recipient's own ``NotificationPreference``.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.teams.models import TeamMembership

    recipients: set[Any] = set()

    if task.assignee_id is not None:
        recipients.add(task.assignee_id)

    # Scrum Master(s) on any team belonging to the task's project. ADR-0078 makes
    # the SM a soft-singleton per team, but a project may have multiple teams, so
    # this can resolve more than one SM — all of them get the impediment.
    sm_ids = TeamMembership.objects.filter(
        team__project_id=task.project_id,
        is_scrum_master=True,
        is_deleted=False,
    ).values_list("user_id", flat=True)
    recipients.update(sm_ids)

    # PM(s): project membership at ADMIN or above (Project Manager / Project Admin).
    pm_ids = ProjectMembership.objects.filter(
        project_id=task.project_id,
        role__gte=Role.ADMIN,
        is_deleted=False,
    ).values_list("user_id", flat=True)
    recipients.update(pm_ids)

    return recipients


def render_blocker_notification(task: Task) -> tuple[str, str]:
    """Render the ``task.blocked`` subject + body — type + age only, NEVER reason.

    The privacy boundary is enforced at the point of render, not just at the
    serializer: the notification body that reaches the SM/PM (and is frozen onto
    the email row by the drain) carries the structured triage signal — the
    blocker type label and a coarse age — and never the free-text reason. A PM
    must not be able to read a contributor's reason through a notification body.

    Args:
        task: The freshly-flagged task.

    Returns:
        ``(subject, body)`` — both reason-free.
    """
    from trueppm_api.apps.projects.models import BlockerType

    type_label = ""
    if task.blocker_type:
        try:
            type_label = BlockerType(task.blocker_type).label
        except ValueError:
            type_label = ""

    age = blocked_age_seconds(task.blocked_since)
    age_label = _coarse_age_label(age)

    subject = f"{task.name} is blocked"
    detail_bits = [b for b in (type_label, age_label) if b]
    if detail_bits:
        body = f'"{task.name}" was flagged blocked — {" · ".join(detail_bits)}.'
    else:
        body = f'"{task.name}" was flagged blocked.'
    return subject, body


def _coarse_age_label(age_seconds: int | None) -> str:
    """Return a coarse human age label ("2d", "3h", "just now") for a blocked age.

    Coarse by design: the standup/notification never needs sub-hour precision, and
    a coarse label avoids implying minute-level surveillance of when a contributor
    flagged their work.
    """
    if age_seconds is None:
        return ""
    days = age_seconds // 86400
    if days >= 1:
        return f"{days}d"
    hours = age_seconds // 3600
    if hours >= 1:
        return f"{hours}h"
    return "just now"


def _blocking_task_payload(task: Task) -> dict[str, Any] | None:
    """Serialize the soft ``blocking_task`` link as ``{id, short_id, title}`` or ``None``.

    Uses the already-``select_related`` ``blocking_task`` to avoid an N+1 across a
    roll-up list. The short_id is rendered with the ``T-`` prefix to match the rest
    of the task surfaces.
    """
    bt = task.blocking_task
    if bt is None:
        return None
    return {
        "id": str(bt.pk),
        "short_id": f"T-{bt.short_id}" if bt.short_id else "",
        "title": bt.name,
    }


def _blocked_row(task: Task) -> dict[str, Any]:
    """Build one reason-free roll-up row for a blocked task.

    Reason text is **omitted entirely** from roll-up rows — for everyone, including
    the assignee. The roll-ups are a triage/escalation surface (who is blocked, on
    what type, for how long, waiting on what); the private reason is read on the
    task drawer, gated by :func:`can_read_blocker_reason`. Omitting it here is the
    simplest correct way to guarantee the roll-up can never leak it.
    """
    return {
        "task_id": str(task.pk),
        "task_short_id": f"T-{task.short_id}" if task.short_id else "",
        "title": task.name,
        "assignee": (
            {"id": str(task.assignee_id), "username": task.assignee.username}
            if task.assignee_id and task.assignee
            else None
        ),
        "blocker_type": task.blocker_type or None,
        "blocked_since": task.blocked_since.isoformat() if task.blocked_since else None,
        "blocked_age_seconds": blocked_age_seconds(task.blocked_since),
        "blocked_by": (
            {"id": str(task.blocked_by_id), "username": task.blocked_by.username}
            if task.blocked_by_id and task.blocked_by
            else None
        ),
        "blocking_task": _blocking_task_payload(task),
    }


def _blocked_queryset(base_qs: Any) -> Any:
    """Filter a Task queryset to flagged-blocked rows, oldest-blocked first.

    "Blocked" is the flag-of-record: a non-empty ``blocked_reason``. Ordered by
    ``blocked_since`` ascending (oldest/most-aged first) because age drives
    escalation — the SM/PM want the longest-running impediments at the top. Rows
    are ``select_related`` on ``assignee``, ``blocked_by``, and ``blocking_task``
    so the roll-up serialization adds no per-row query.
    """
    return (
        base_qs.exclude(blocked_reason="")
        .filter(is_deleted=False)
        .select_related("assignee", "blocked_by", "blocking_task")
        .order_by("blocked_since", "id")
    )


def project_blocked_rollup(project: Any) -> dict[str, Any]:
    """Return the reason-free "blocked tasks on this project" roll-up (#1134).

    Backs ``GET /projects/{id}/blocked/``. Lists every flagged-blocked task in the
    project (oldest-blocked first) with type + age + actor + assignee +
    blocking-task link — and **no reason text** (see :func:`_blocked_row`).

    Args:
        project: The ``Project`` whose blocked tasks to list.

    Returns:
        ``{"project_id", "count", "blocked": [<row>, ...]}``.
    """
    qs = _blocked_queryset(project.tasks)
    rows = [_blocked_row(t) for t in qs]
    return {"project_id": str(project.pk), "count": len(rows), "blocked": rows}


def sprint_blocked_rollup(sprint: Any) -> dict[str, Any]:
    """Return the reason-free "blocked tasks in this sprint" roll-up (#1134).

    Backs ``GET /sprints/{id}/blocked/`` — the SM's sprint-scoped impediment list.
    Same shape and same reason-omission as :func:`project_blocked_rollup`, scoped
    to the sprint's tasks.

    Args:
        sprint: The ``Sprint`` whose blocked tasks to list.

    Returns:
        ``{"sprint_id", "count", "blocked": [<row>, ...]}``.
    """
    from trueppm_api.apps.projects.models import Task

    qs = _blocked_queryset(Task.objects.filter(sprint_id=sprint.pk))
    rows = [_blocked_row(t) for t in qs]
    return {"sprint_id": str(sprint.pk), "count": len(rows), "blocked": rows}
