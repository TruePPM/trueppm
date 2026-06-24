"""Estimation-poker endpoints (ADR-0179, #863).

Surface (mirrors the top-level ``sprints/<pk>/...`` routing — project membership is
enforced per-object via ``check_object_permissions`` on the resolved project, not from a
``project_pk`` in the URL):

  GET  /api/v1/sprints/<sprint_pk>/poker/        — live rounds for the sprint (participant)
  POST /api/v1/sprints/<sprint_pk>/poker/        — open a round for {task} (facilitator)
  POST /api/v1/poker/<pk>/vote/                  — upsert my vote (participant)
  POST /api/v1/poker/<pk>/reveal/                — open -> revealed (facilitator)
  POST /api/v1/poker/<pk>/reopen/                — revealed -> open (facilitator)
  POST /api/v1/poker/<pk>/commit/                — write story_points, close (facilitator)
  POST /api/v1/poker/<pk>/cancel/                — abandon the round (facilitator)

Facilitator = ``can_manage_scope_with_facet`` (Admin+ OR Scrum-Master/Product-Owner facet,
ADR-0078/0123) — the same authority that runs sprint scope changes. Participant = a
default-team member (``is_team_member``). The session serializer privacy-filters by state:
pre-reveal it exposes only a vote count + the caller's own vote (ADR-0179 §2).
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    IsProjectNotArchived,
    _membership_role,
    can_manage_scope_with_facet,
)
from trueppm_api.apps.projects import poker_services
from trueppm_api.apps.projects.models import (
    POKER_CARD_VALUES,
    PokerSession,
    PokerSessionState,
    Project,
    Sprint,
)
from trueppm_api.apps.projects.poker_services import PokerConflict
from trueppm_api.apps.projects.serializers import _MentionAuthorMiniSerializer
from trueppm_api.apps.teams.services import is_team_member, team_member_user_ids

# ---------------------------------------------------------------------------
# Serializers (drf-spectacular discovers these for the schema)
# ---------------------------------------------------------------------------


class _PokerTaskSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField(source="task_id", read_only=True)
    name = serializers.CharField(source="task.name", read_only=True)


class _PokerMyVoteSerializer(serializers.Serializer[Any]):
    value = serializers.IntegerField(allow_null=True)
    comment = serializers.CharField()


class _PokerRevealedVoteSerializer(serializers.Serializer[Any]):
    voter = _MentionAuthorMiniSerializer(read_only=True)
    value = serializers.IntegerField(allow_null=True)
    comment = serializers.CharField()


class PokerSessionSerializer(serializers.Serializer[Any]):
    """Privacy-filtered poker round (ADR-0179 §2).

    Always returns the round's identity, the caller's own vote (``my_vote`` — survives a
    refresh), and a ``vote_count``. The per-member ``votes`` list is returned ONLY once the
    round is revealed/committed; while ``open`` it is empty so no participant can read
    another's value pre-reveal.
    """

    id = serializers.UUIDField(read_only=True)
    task = serializers.SerializerMethodField()
    state = serializers.ChoiceField(choices=PokerSessionState.choices)
    committed_points = serializers.IntegerField(allow_null=True)
    started_by = _MentionAuthorMiniSerializer(read_only=True)
    started_at = serializers.DateTimeField()
    my_vote = serializers.SerializerMethodField()
    vote_count = serializers.SerializerMethodField()
    participant_count = serializers.SerializerMethodField()
    votes = serializers.SerializerMethodField()

    def get_task(self, obj: PokerSession) -> dict[str, Any]:
        return _PokerTaskSerializer(obj).data

    def _uid(self) -> Any:
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
            return None
        return user.pk

    def get_my_vote(self, obj: PokerSession) -> dict[str, Any] | None:
        uid = self._uid()
        if uid is None:
            return None
        mine = next((v for v in obj.votes.all() if v.voter_id == uid), None)
        return _PokerMyVoteSerializer(mine).data if mine is not None else None

    def get_vote_count(self, obj: PokerSession) -> int:
        # `votes` is prefetched (prefetch_related("votes__voter")), so len() reads the
        # cache — using .count() here would fire a second query and defeat the prefetch.
        # nosemgrep: python.sqlalchemy.performance.performance-improvements.len-all-count
        return len(obj.votes.all())

    def get_participant_count(self, obj: PokerSession) -> int:
        return int(self.context.get("participant_count", 0))

    def get_votes(self, obj: PokerSession) -> list[dict[str, Any]]:
        # Privacy gate: per-member votes are exposed only after reveal.
        if obj.state in (PokerSessionState.REVEALED, PokerSessionState.COMMITTED):
            return list(_PokerRevealedVoteSerializer(list(obj.votes.all()), many=True).data)
        return []


class OpenPokerSerializer(serializers.Serializer[Any]):
    """POST body — open a round for one task."""

    task = serializers.UUIDField()


class CastVoteSerializer(serializers.Serializer[Any]):
    """POST body — the caller's estimate (``value`` null = the "?" card)."""

    value = serializers.ChoiceField(choices=POKER_CARD_VALUES, allow_null=True)
    comment = serializers.CharField(required=False, allow_blank=True, max_length=280, default="")


class CommitPokerSerializer(serializers.Serializer[Any]):
    """POST body — the agreed value written to ``Task.story_points``."""

    points = serializers.ChoiceField(choices=POKER_CARD_VALUES)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class _PokerBase(APIView):
    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]  # noqa: RUF012

    def _project(self, project_id: Any) -> Project:
        project = get_object_or_404(Project, pk=project_id, is_deleted=False)
        self.check_object_permissions(self.request, project)
        return project

    def _sprint(self, sprint_pk: str) -> Sprint:
        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=sprint_pk, is_deleted=False
        )
        self.check_object_permissions(self.request, sprint.project)
        return sprint

    def _session(self, pk: str) -> PokerSession:
        session = get_object_or_404(
            PokerSession.objects.select_related("sprint__project", "task"), pk=pk
        )
        self.check_object_permissions(self.request, session.sprint.project)
        return session

    def _require_facilitator(self, project_id: Any) -> None:
        role = _membership_role(self.request, project_id)
        if not can_manage_scope_with_facet(self.request.user, project_id, role):
            raise PermissionDenied(
                "Only the Scrum Master, Product Owner, or a project admin can run estimation poker."
            )

    def _require_participant(self, project_id: Any) -> None:
        if not is_team_member(self.request.user, project_id):
            raise PermissionDenied("Only a team member can vote in estimation poker.")

    def _fresh(self, session_id: Any) -> PokerSession:
        # Re-read with votes + relations for the privacy-filtered serializer.
        return (
            PokerSession.objects.select_related("sprint__project", "task", "started_by")
            .prefetch_related("votes__voter")
            .get(pk=session_id)
        )

    def _payload(self, session: PokerSession, project_id: Any) -> dict[str, Any]:
        ctx = {
            "request": self.request,
            "participant_count": len(team_member_user_ids(project_id)),
        }
        return PokerSessionSerializer(session, context=ctx).data

    def _broadcast(self, project_id: Any, session: PokerSession) -> None:
        from django.db import transaction

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Snapshot plain values before the on_commit lambda (broadcast-check H-1). No vote
        # values in the payload — the privacy gate is REST-side; the event is just a nudge.
        project_id_str = str(project_id)
        session_id_str = str(session.pk)
        task_id_str = str(session.task_id)
        state_str = str(session.state)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "poker_session_updated",
                {"id": session_id_str, "task_id": task_id_str, "state": state_str},
            )
        )

    def _transition_response(self, session: PokerSession, project_id: Any) -> Response:
        self._broadcast(project_id, session)
        fresh = self._fresh(session.pk)
        return Response(self._payload(fresh, project_id), status=status.HTTP_200_OK)

    @staticmethod
    def _conflict(exc: PokerConflict) -> Response:
        code = status.HTTP_404_NOT_FOUND if exc.code == "not_found" else status.HTTP_409_CONFLICT
        return Response({"detail": exc.message, "code": exc.code}, status=code)


class SprintPokerView(_PokerBase):
    """GET the sprint's live rounds; POST opens a new round (facilitator)."""

    @extend_schema(
        summary="Live poker rounds for a sprint", responses=PokerSessionSerializer(many=True)
    )
    def get(self, request: Request, sprint_pk: str) -> Response:
        sprint = self._sprint(sprint_pk)
        sessions = poker_services.live_sessions_for_sprint(sprint.pk)
        ctx = {
            "request": request,
            "participant_count": len(team_member_user_ids(sprint.project_id)),
        }
        return Response(PokerSessionSerializer(sessions, many=True, context=ctx).data)

    @extend_schema(
        summary="Open an estimation-poker round for a task",
        request=OpenPokerSerializer,
        responses={200: PokerSessionSerializer, 409: OpenApiResponse(description="Already live.")},
    )
    def post(self, request: Request, sprint_pk: str) -> Response:
        sprint = self._sprint(sprint_pk)
        self._require_facilitator(sprint.project_id)
        body = OpenPokerSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        from trueppm_api.apps.projects.models import Task

        task = get_object_or_404(Task, pk=body.validated_data["task"], is_deleted=False)
        try:
            session = poker_services.open_session(sprint=sprint, task=task, actor=request.user)
        except PokerConflict as exc:
            return self._conflict(exc)
        return self._transition_response(session, sprint.project_id)


class PokerVoteView(_PokerBase):
    @extend_schema(
        summary="Cast or change my vote",
        request=CastVoteSerializer,
        responses=PokerSessionSerializer,
    )
    def post(self, request: Request, pk: str) -> Response:
        session = self._session(pk)
        project_id = session.sprint.project_id
        self._require_participant(project_id)
        body = CastVoteSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            session = poker_services.cast_vote(
                session_id=session.pk,
                voter=request.user,
                value=body.validated_data["value"],
                comment=body.validated_data.get("comment", ""),
            )
        except PokerConflict as exc:
            return self._conflict(exc)
        return self._transition_response(session, project_id)


class PokerRevealView(_PokerBase):
    @extend_schema(summary="Reveal the votes", request=None, responses=PokerSessionSerializer)
    def post(self, request: Request, pk: str) -> Response:
        session = self._session(pk)
        project_id = session.sprint.project_id
        self._require_facilitator(project_id)
        try:
            session = poker_services.reveal(session_id=session.pk)
        except PokerConflict as exc:
            return self._conflict(exc)
        return self._transition_response(session, project_id)


class PokerReopenView(_PokerBase):
    @extend_schema(summary="Reopen for a re-vote", request=None, responses=PokerSessionSerializer)
    def post(self, request: Request, pk: str) -> Response:
        session = self._session(pk)
        project_id = session.sprint.project_id
        self._require_facilitator(project_id)
        try:
            session = poker_services.reopen(session_id=session.pk)
        except PokerConflict as exc:
            return self._conflict(exc)
        return self._transition_response(session, project_id)


class PokerCommitView(_PokerBase):
    @extend_schema(
        summary="Commit the agreed points (writes Task.story_points)",
        request=CommitPokerSerializer,
        responses=PokerSessionSerializer,
    )
    def post(self, request: Request, pk: str) -> Response:
        session = self._session(pk)
        project_id = session.sprint.project_id
        self._require_facilitator(project_id)
        body = CommitPokerSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            session = poker_services.commit_points(
                session_id=session.pk, points=body.validated_data["points"]
            )
        except PokerConflict as exc:
            return self._conflict(exc)
        return self._transition_response(session, project_id)


class PokerCancelView(_PokerBase):
    @extend_schema(summary="Cancel the round", request=None, responses=PokerSessionSerializer)
    def post(self, request: Request, pk: str) -> Response:
        session = self._session(pk)
        project_id = session.sprint.project_id
        self._require_facilitator(project_id)
        try:
            session = poker_services.cancel(session_id=session.pk)
        except PokerConflict as exc:
            return self._conflict(exc)
        return self._transition_response(session, project_id)
