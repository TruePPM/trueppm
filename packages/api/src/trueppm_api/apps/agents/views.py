"""Team-readable agent-action log endpoint (ADR-0112 §1.3, #1805).

``GET /api/v1/agent-actions/`` lists what the team's agents did — scoped so a caller sees
only actions in projects they are a member of, plus their own (actions where they are the
human principal). This is the OSS "team-readable" surface; the *immutable, notarized,
org-wide* trail is Enterprise (#146). The endpoint is read-only: the rows are append-only
and written only by ``record_agent_action``.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from django.db.models import Q
from django.utils.dateparse import parse_datetime
from rest_framework import permissions, viewsets

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.agents.models import AgentAction
from trueppm_api.apps.agents.serializers import AgentActionSerializer
from trueppm_api.apps.projects.models import Project

if TYPE_CHECKING:
    from django.db.models import QuerySet


class AgentActionViewSet(viewsets.ReadOnlyModelViewSet):  # type: ignore[type-arg]
    """Read-only, membership-scoped list/retrieve of audited agent actions.

    Ordering is by ``sequence`` (chain order); filtering by ``verdict``, ``project``,
    ``program``, ``since``, and ``constraint`` is supported for the common "show me
    refusals" / "show me this project" / "show me this program's agents (last 7d)" /
    "show me every graph_validation refusal" (ADR-0421, #1850) triage queries. The
    ``program`` filter (#2020) powers the per-program agent-oversight panel: a program
    groups projects, so a program's agent log is the union of the chain across the
    program's member projects — always intersected with the caller's own membership
    scope below, so the filter narrows what the caller may already see and never widens it.
    """

    serializer_class = AgentActionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self) -> QuerySet[AgentAction]:
        user = self.request.user
        if not user.is_authenticated:
            return AgentAction.objects.none()

        member_project_ids = ProjectMembership.objects.filter(
            user=user,
            is_deleted=False,
        ).values_list("project_id", flat=True)

        # A caller sees actions in their projects, plus their own agent's actions (which
        # may target a project they no longer belong to, or none at all). The serializer
        # renders project/principal as their FK ids (already on the row) and only the
        # token *prefix*; ``refusal_detail`` is the one reverse OneToOne it reads, so
        # select_related it to avoid an N+1 across the page (ADR-0421, #1850).
        qs = AgentAction.objects.filter(
            Q(project_id__in=member_project_ids) | Q(principal=user)
        ).select_related("refusal_detail")

        verdict = self.request.query_params.get("verdict")
        if verdict:
            qs = qs.filter(verdict=verdict)
        constraint = self.request.query_params.get("constraint")
        if constraint:
            # Filters through the side-car; non-refusals (no detail) drop out naturally.
            qs = qs.filter(refusal_detail__constraint=constraint)
        project_id = self.request.query_params.get("project")
        if project_id:
            # Validate the UUID here so a malformed ?project= returns an empty list rather
            # than raising a 500 at queryset evaluation.
            try:
                uuid.UUID(str(project_id))
            except ValueError:
                return AgentAction.objects.none()
            qs = qs.filter(project_id=project_id)

        program_id = self.request.query_params.get("program")
        if program_id:
            try:
                uuid.UUID(str(program_id))
            except ValueError:
                return AgentAction.objects.none()
            # Resolve the program's project ids and filter with project_id__in so the query
            # rides the existing (project, -occurred_at) index rather than joining through
            # Project on every row (perf: one indexed IN vs. a per-row join). The result is
            # still bounded by the membership/principal scope set above — a non-member gains
            # nothing by naming a program they cannot see.
            program_project_ids = Project.objects.filter(program_id=program_id).values_list(
                "id", flat=True
            )
            qs = qs.filter(project_id__in=program_project_ids)

        since = self.request.query_params.get("since")
        if since:
            # A malformed ?since= is ignored (the range simply doesn't narrow) rather than
            # 500ing or emptying the list — a lenient time-window filter, unlike the strict
            # UUID filters above where a bad id can only be a client bug.
            parsed_since = parse_datetime(since)
            if parsed_since is not None:
                qs = qs.filter(occurred_at__gte=parsed_since)

        # Order by -occurred_at (the leading key of the (project|principal, -occurred_at)
        # indexes so the membership/principal filter and the sort share an index), with
        # -sequence as a strict, deterministic tiebreak for same-instant rows.
        return qs.order_by("-occurred_at", "-sequence")
