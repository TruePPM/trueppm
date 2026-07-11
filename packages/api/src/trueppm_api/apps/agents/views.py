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
from rest_framework import permissions, viewsets

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.agents.models import AgentAction
from trueppm_api.apps.agents.serializers import AgentActionSerializer

if TYPE_CHECKING:
    from django.db.models import QuerySet


class AgentActionViewSet(viewsets.ReadOnlyModelViewSet):  # type: ignore[type-arg]
    """Read-only, membership-scoped list/retrieve of audited agent actions.

    Ordering is by ``sequence`` (chain order); filtering by ``verdict`` and ``project`` is
    supported for the common "show me refusals" / "show me this project" queries.
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
        # token *prefix*, so no select_related join is needed.
        qs = AgentAction.objects.filter(Q(project_id__in=member_project_ids) | Q(principal=user))

        verdict = self.request.query_params.get("verdict")
        if verdict:
            qs = qs.filter(verdict=verdict)
        project_id = self.request.query_params.get("project")
        if project_id:
            # Validate the UUID here so a malformed ?project= returns an empty list rather
            # than raising a 500 at queryset evaluation.
            try:
                uuid.UUID(str(project_id))
            except ValueError:
                return AgentAction.objects.none()
            qs = qs.filter(project_id=project_id)

        # Order by -occurred_at (the leading key of the (project|principal, -occurred_at)
        # indexes so the membership/principal filter and the sort share an index), with
        # -sequence as a strict, deterministic tiebreak for same-instant rows.
        return qs.order_by("-occurred_at", "-sequence")
