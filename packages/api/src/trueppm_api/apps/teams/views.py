"""Viewsets for the teams app (ADR-0078 §E).

The 0.3 slice is read + facet/role assignment only:

* ``TeamViewSet`` — list a project's teams and retrieve one (no create/delete; the
  default team is migration-created and multi-team management is #599).
* ``TeamMembershipViewSet`` — list the roster and PATCH a member's role/facets.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import Count, Q, QuerySet
from rest_framework import status, viewsets
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.teams.models import Team, TeamMembership
from trueppm_api.apps.teams.permissions import IsTeamFacetEditor, IsTeamMember
from trueppm_api.apps.teams.serializers import (
    TeamMembershipReadSerializer,
    TeamMembershipWriteSerializer,
    TeamSerializer,
)
from trueppm_api.apps.teams.services import FACET_FIELDS


class TeamViewSet(viewsets.GenericViewSet[Team]):
    """Read-only team access, nested under a project and as a top-level detail route."""

    permission_classes = [IsAuthenticated, IsTeamMember]
    serializer_class = TeamSerializer

    def get_queryset(self) -> QuerySet[Team]:
        qs = Team.objects.filter(is_deleted=False).annotate(
            member_count_annotated=Count("memberships", filter=Q(memberships__is_deleted=False))
        )
        project_pk = self.kwargs.get("project_pk")
        if project_pk is not None:
            qs = qs.filter(project_id=project_pk)
        return qs.order_by("-is_default", "name")

    def list(self, request: Request, **kwargs: object) -> Response:
        # Paginate (#1317): a project's team list is small today, but the
        # endpoint had no bound at all — page it through the project default so
        # it can never serialize an unbounded set as multi-team lands (#599).
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        if page is not None:
            return self.get_paginated_response(TeamSerializer(page, many=True).data)
        return Response(TeamSerializer(queryset, many=True).data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        team = self.get_object()
        return Response(TeamSerializer(team).data)


class TeamMembershipViewSet(IdempotencyMixin, viewsets.GenericViewSet[TeamMembership]):
    """Roster list + role/facet assignment.

    URL: /api/v1/teams/{team_pk}/members/
         /api/v1/teams/{team_pk}/members/{pk}/   (PATCH only)

    The facets are soft-singletons: setting a facet on one member clears it from
    whichever member currently holds it on the same team, in a single transaction
    (reassign-moves-the-facet — ADR-0078's "transitional state during handoff" is
    realized as an atomic move rather than a tolerated double-holder).
    """

    permission_classes = [IsAuthenticated, IsTeamFacetEditor]

    def get_serializer_class(self) -> type[Any]:
        if self.action in ("partial_update", "update"):
            return TeamMembershipWriteSerializer
        return TeamMembershipReadSerializer

    def _get_team_or_404(self) -> Team:
        try:
            return Team.objects.get(pk=self.kwargs["team_pk"], is_deleted=False)
        except Team.DoesNotExist as err:
            raise NotFound("Team not found.") from err

    def get_queryset(self) -> QuerySet[TeamMembership]:
        return (
            TeamMembership.objects.select_related("user", "team")
            .filter(team_id=self.kwargs["team_pk"], is_deleted=False)
            .order_by("user__username")
        )

    def list(self, request: Request, **kwargs: object) -> Response:
        self._get_team_or_404()
        # Paginate (#1317) — the roster grows with the team; page it through the
        # project default rather than serializing every membership at once.
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        if page is not None:
            return self.get_paginated_response(TeamMembershipReadSerializer(page, many=True).data)
        return Response(TeamMembershipReadSerializer(queryset, many=True).data)

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        team = self._get_team_or_404()
        instance = self.get_object()

        serializer = TeamMembershipWriteSerializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # Rows the broadcast must cover: the edited member plus any prior facet
        # holder that gets cleared (the board badge moves on both). Each entry is
        # a plain-value snapshot taken inside the transaction so the on_commit
        # closure never dereferences a live ORM instance after commit.
        changed: list[dict[str, object]] = []

        with transaction.atomic():
            # Lock the target row too (not just the prior holders) so two
            # concurrent reassignments of the same facet serialize on the same
            # rows rather than racing to a transient zero/two-holder state.
            locked = TeamMembership.objects.select_for_update().get(pk=instance.pk)

            # Reassign each facet being turned ON: clear it from the current holder
            # so the team ends with at most one. Locking the holders avoids a race
            # where two concurrent assignments both believe they cleared the prior.
            for facet in FACET_FIELDS:
                if data.get(facet) is True:
                    holders = (
                        TeamMembership.objects.select_for_update()
                        .filter(team=team, is_deleted=False, **{facet: True})
                        .exclude(pk=locked.pk)
                    )
                    for holder in holders:
                        setattr(holder, facet, False)
                        holder.save(update_fields=[facet])
                        changed.append(self._broadcast_snapshot(team, holder))

            for field, value in data.items():
                setattr(locked, field, value)
            locked.save(update_fields=list(data.keys()))
            instance = locked
            changed.append(self._broadcast_snapshot(team, locked))

        # Broadcast to the project board so other clients reflect the new facet
        # holder(s) without a refetch. Deferred to commit so a rolled-back write
        # broadcasts nothing.
        project_id = str(team.project_id)
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        def _emit() -> None:
            for payload in changed:
                broadcast_board_event(project_id, "team_member_changed", payload)

        transaction.on_commit(_emit)

        return Response(TeamMembershipReadSerializer(instance).data, status=status.HTTP_200_OK)

    @staticmethod
    def _broadcast_snapshot(team: Team, membership: TeamMembership) -> dict[str, object]:
        """Capture a membership's broadcast fields as plain values (no ORM ref)."""
        return {
            "membership_id": str(membership.pk),
            "user_id": str(membership.user_id),
            "team_id": str(team.pk),
            "role": membership.role,
            "is_scrum_master": membership.is_scrum_master,
            "is_product_owner": membership.is_product_owner,
        }
