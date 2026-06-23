"""Decisions-view visibility gate + queryset helpers (ADR-0165, #748).

The Decisions view surfaces every task note flagged ``decision=True`` for a project,
optionally scoped to one sprint. Visibility is team-owned: by default the list is
readable by the team and the PM only; an *oversight reader* (a project member who is
not on the default team and is below Admin) sees it only once a project Admin opts in
via :class:`~trueppm_api.apps.projects.models.ProjectDecisionsPolicy`.

These helpers are pure (no view imports) so both the ``ProjectViewSet.decisions``
list action and the consent ``ProjectDecisionsPolicyView`` can share the gate without
an import cycle.
"""

from __future__ import annotations

from typing import Any

from django.db.models import F, QuerySet

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.projects.models import Project, ProjectDecisionsPolicy, TaskNote


def get_or_create_decisions_policy(project: Project) -> ProjectDecisionsPolicy:
    """Lazily materialize the project's decisions-visibility policy.

    Mirrors ``signal_privacy_services.get_or_create_policy`` — the row is created on
    first access so existing projects need no data migration. A fresh row carries the
    default-closed posture (``oversight_visible=False``).
    """
    policy, _ = ProjectDecisionsPolicy.objects.get_or_create(project=project)
    return policy


def can_read_decisions(
    request: Any,
    project_id: Any,
    *,
    policy: ProjectDecisionsPolicy | None = None,
) -> bool:
    """Whether the requester may read the project's Decisions view (ADR-0165 §3).

    "Team + PM" = ``Role.MEMBER`` (Team Member) and above — the project's contributors and
    managers, who see the log by default. A requester below the Member band — a Viewer, or
    an Enterprise read-augmented/auditor role in the reserved 1–99 ordinal band (ADR-0072) —
    is the single-project stand-in for a PMO/oversight reader and is suppressed until the
    team opts in (``oversight_visible``).

    Role, not team membership, is the discriminator: every ``ProjectMembership`` mirrors
    onto the default team (teams/signals.py), so ``is_team_member`` cannot tell a
    read-only observer apart from a contributor — the Role ladder can. ``policy`` may be
    passed to avoid a second lookup; it is fetched lazily otherwise (read path, no row
    creation).
    """
    role = _membership_role(request, project_id)
    if role is None:
        return False
    if role >= Role.MEMBER:
        return True
    if policy is None:
        # Read path: do not create the row on a denied/allowed check. Absent row ⇒
        # default-closed, so a missing policy resolves to "not oversight-visible".
        oversight_visible = (
            ProjectDecisionsPolicy.objects.filter(project_id=project_id)
            .values_list("oversight_visible", flat=True)
            .first()
            or False
        )
    else:
        oversight_visible = policy.oversight_visible
    return bool(oversight_visible)


def decision_notes_queryset(project_id: Any, sprint_id: str | None = None) -> QuerySet[TaskNote]:
    """Decision-flagged, non-deleted notes for a project, optionally one sprint.

    Ordered newest-sprint-first then newest-decision-first so the web client can group
    by sprint with the most recent sprint (and the backlog group, sprint null) leading.
    ``select_related`` pulls the task + sprint + author so the serializer renders the
    task/sprint context and the author mini without an N+1.
    """
    qs = TaskNote.objects.filter(
        task__project_id=project_id,
        is_deleted=False,
        decision=True,
    ).select_related("author", "task", "task__sprint")
    if sprint_id is not None:
        qs = qs.filter(task__sprint_id=sprint_id)
    # NULLS LAST on sprint start so the backlog (sprint-less) group trails the dated
    # sprints — Postgres sorts NULLs first under a bare DESC, so make it explicit;
    # -created_at orders decisions newest-first within each sprint.
    return qs.order_by(F("task__sprint__start_date").desc(nulls_last=True), "-created_at")
