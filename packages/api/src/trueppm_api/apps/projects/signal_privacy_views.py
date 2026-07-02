"""Signal-privacy policy endpoints (ADR-0104 §1.1 + Amendment A / #930).

Surface:
  GET   /api/v1/projects/<project_pk>/signal-privacy/             — read posture (+ open proposals)
  PATCH /api/v1/projects/<project_pk>/signal-privacy/             — set one audience
  POST  .../signal-privacy/raise-ceiling/    — raise → propose; lower → apply
  POST  /api/v1/projects/<project_pk>/signal-privacy/ratchet-down/
  GET   /api/v1/projects/<project_pk>/signal-privacy/ceiling-proposals/    — list (team-readable)
  POST  .../signal-privacy/ceiling-proposals/<proposal_pk>/vote/           — cast/change a vote
  POST  .../signal-privacy/ceiling-proposals/<proposal_pk>/withdraw/       — proposer cancels

Write gates:
  * set-audience / ratchet  — the facilitator's dial (Scrum-Master facet, ADR-0078
    / #927) OR a project Admin (role >= ADMIN). Bounded by the ceiling, so it can
    never widen exposure past what the team authorized.
  * raise-ceiling           — the team-owned act (ADR-0104 §1.1 + Amendment A / #930).
    A *raise* opens a ratification proposal (facilitator/Admin may propose); the
    ceiling applies only once the team ratifies (strict majority of the team roster).
    A *lower* and all set-audience moves stay immediate single actions. There is no
    management bypass — that would reopen the §2 back-door the model closes.
  * vote                    — any active team member (TeamMembership of the default
    team). A non-team project Admin/PM cannot vote (Amendment A.2).
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

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    IsProjectNotArchived,
    _membership_role,
)
from trueppm_api.apps.projects.models import (
    CeilingRaiseStatus,
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    SignalCeilingRaiseProposal,
)
from trueppm_api.apps.projects.signal_privacy_services import (
    SIGNAL_KEYS,
    CeilingProposalConflict,
    cast_ceiling_vote,
    get_or_create_policy,
    live_open_proposals,
    proposal_tally,
    propose_or_apply_ceiling_change,
    ratchet_down_to_team,
    requester_signal_tier,
    set_signal_audience,
    withdraw_ceiling_proposal,
)
from trueppm_api.apps.teams.services import (
    has_team_facet,
    is_team_member,
    team_member_user_ids,
)

# ---------------------------------------------------------------------------
# Serializers (declared here; drf-spectacular discovers them for the schema)
# ---------------------------------------------------------------------------


class _SignalPairSerializer(serializers.Serializer[Any]):
    audience = serializers.ChoiceField(choices=SignalAudience.choices)
    ceiling = serializers.ChoiceField(choices=SignalAudience.choices)


class CeilingVoteSerializer(serializers.Serializer[Any]):
    """One team member's vote on a ceiling-raise proposal (team-readable)."""

    voter = serializers.CharField()
    choice = serializers.CharField()
    created_at = serializers.DateTimeField()


class CeilingProposalSerializer(serializers.Serializer[Any]):
    """A ceiling-raise ratification proposal with its live tally (ADR-0104 Amendment A)."""

    id = serializers.CharField()
    signal = serializers.CharField()
    from_ceiling = serializers.ChoiceField(choices=SignalAudience.choices)
    to_ceiling = serializers.ChoiceField(choices=SignalAudience.choices)
    status = serializers.ChoiceField(choices=CeilingRaiseStatus.choices)
    proposed_by = serializers.CharField(allow_null=True)
    created_at = serializers.DateTimeField()
    expires_at = serializers.DateTimeField()
    resolved_at = serializers.DateTimeField(allow_null=True)
    approve_count = serializers.IntegerField()
    reject_count = serializers.IntegerField()
    eligible_count = serializers.IntegerField()
    threshold = serializers.IntegerField()
    your_vote = serializers.CharField(allow_null=True)
    can_vote = serializers.BooleanField()
    votes = CeilingVoteSerializer(many=True)


class SignalPrivacyPolicySerializer(serializers.Serializer[Any]):
    """Read shape: the resolved per-signal posture + what the requester may do."""

    signals = serializers.DictField(child=_SignalPairSerializer())
    requester_tier = serializers.ChoiceField(choices=SignalAudience.choices, allow_null=True)
    can_set_audience = serializers.BooleanField()
    can_raise_ceiling = serializers.BooleanField()
    can_vote = serializers.BooleanField()
    # Per-signal live ratification proposal (Amendment A) — Sarah's pending indicator.
    open_proposals = serializers.DictField(child=CeilingProposalSerializer())


class SetAudienceSerializer(serializers.Serializer[Any]):
    """PATCH body — move one signal's audience within [TEAM, ceiling]."""

    signal = serializers.ChoiceField(choices=[(k, k) for k in SIGNAL_KEYS])
    audience = serializers.ChoiceField(choices=SignalAudience.choices)


class RaiseCeilingSerializer(serializers.Serializer[Any]):
    """POST body — set one signal's ceiling (the team-owned authorization)."""

    signal = serializers.ChoiceField(choices=[(k, k) for k in SIGNAL_KEYS])
    ceiling = serializers.ChoiceField(choices=SignalAudience.choices)


class CeilingVoteRequestSerializer(serializers.Serializer[Any]):
    """POST body — cast or change a vote on a ceiling-raise proposal."""

    choice = serializers.ChoiceField(choices=[("approve", "approve"), ("reject", "reject")])


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _is_facilitator_or_admin(request: Request, project_id: Any) -> bool:
    """Facilitator (Scrum-Master facet) OR project Admin — the propose/set-audience gate."""
    role = _membership_role(request, project_id)
    if role is not None and role >= Role.ADMIN:
        return True
    return has_team_facet(request.user, project_id, "is_scrum_master")


def _serialize_proposal(
    proposal: SignalCeilingRaiseProposal,
    request: Request,
    voter_ids: set[Any] | None = None,
) -> dict[str, Any]:
    """Build the team-readable proposal payload + live tally (Amendment A.6).

    Pass ``voter_ids`` (the project's roster, computed once) when serializing a list so
    the tally and the ``can_vote`` derivation reuse it instead of querying per proposal.

    Per-voter privacy (ADR-0104 §2 + Amendment A.6/B.2, issue 1553): the individual
    ``votes`` list (which member voted which way) is a *team* signal — team-readable,
    never project-wide. A requester who is not on the default-team roster (e.g. a
    non-team project Admin/PM or a Viewer) is structurally outside the ladder for this
    signal, so the per-voter choices are redacted for them. They still receive the
    governance aggregate the policy-GET pending indicator needs — the tally counts,
    ``threshold``, ``eligible_count``, ``to_ceiling``, ``expires_at`` and their own
    ``your_vote`` (exactly the A.6 ``open_proposals`` shape) — but never the individual
    choices. Team members receive the full per-voter list. This mirrors the write-side
    ``is_team_member`` gate on voting (Amendment A.2 / A.5: no management back-door).
    """
    if voter_ids is None:
        voter_ids = team_member_user_ids(proposal.project_id)
    tally = proposal_tally(proposal, voter_ids=voter_ids)
    votes = list(proposal.votes.all())
    user = request.user
    uid = user.pk if getattr(user, "is_authenticated", False) else None
    your_vote: str | None = (
        next((v.choice for v in votes if v.voter_id == uid), None) if uid is not None else None
    )
    # Team membership drives both can_vote and per-voter-detail visibility; derived
    # from the roster set already in hand (no extra is_team_member query).
    is_team_reader = uid is not None and uid in voter_ids
    can_vote = proposal.status == CeilingRaiseStatus.OPEN and is_team_reader
    # Per-voter choices stay team-scoped (issue 1553): redact for non-team readers so a
    # project-level Admin/Viewer cannot see how each teammate voted, while keeping the
    # aggregate tally that management legitimately reads for the pending indicator.
    voter_detail = (
        [{"voter": str(v.voter_id), "choice": v.choice, "created_at": v.created_at} for v in votes]
        if is_team_reader
        else []
    )
    return {
        "id": str(proposal.id),
        "signal": proposal.signal_key,
        "from_ceiling": proposal.from_ceiling,
        "to_ceiling": proposal.to_ceiling,
        "status": proposal.status,
        "proposed_by": str(proposal.proposed_by_id) if proposal.proposed_by_id else None,
        "created_at": proposal.created_at,
        "expires_at": proposal.expires_at,
        "resolved_at": proposal.resolved_at,
        "your_vote": your_vote,
        "can_vote": can_vote,
        "votes": voter_detail,
        **tally,
    }


def _serialize_policy(
    request: Request, project_id: Any, policy: ProjectSignalPrivacyPolicy
) -> dict[str, Any]:
    # The reader band (TEAM for the team incl. the SM; TEAM_SM_PM for the PM) does
    # not encode the SM *write* capability, so the write gate is checked directly:
    # facilitator (SM facet) OR project Admin.
    can_write = _is_facilitator_or_admin(request, project_id)
    # One roster fetch drives both can_vote and every open-proposal tally below.
    voter_ids = team_member_user_ids(project_id)
    user = request.user
    can_vote = getattr(user, "is_authenticated", False) and user.pk in voter_ids
    open_proposals: dict[str, Any] = {
        key: _serialize_proposal(proposal, request, voter_ids=voter_ids)
        for key, proposal in live_open_proposals(project_id).items()
    }
    return {
        "signals": {key: policy.resolved(key) for key in SIGNAL_KEYS},
        "requester_tier": requester_signal_tier(request, project_id),
        # set-audience (immediate) and propose-raise share the facilitator/Admin gate;
        # casting a ratification vote is the broader team-member gate.
        "can_set_audience": can_write,
        "can_raise_ceiling": can_write,
        "can_vote": can_vote,
        "open_proposals": open_proposals,
    }


class _SignalPrivacyBase(APIView):
    """Common project resolution + member gate for every signal-privacy endpoint."""

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]  # noqa: RUF012

    def _project(self, project_pk: str) -> Project:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)
        return project

    def _require_writer(self, project_id: Any) -> None:
        if not _is_facilitator_or_admin(self.request, project_id):
            raise PermissionDenied(
                "Only the Scrum Master or a project Admin can change signal privacy."
            )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class SignalPrivacyPolicyView(_SignalPrivacyBase):
    """GET the posture; PATCH one signal's audience (within its ceiling)."""

    @extend_schema(
        summary="Read the team-signal privacy posture",
        responses=SignalPrivacyPolicySerializer,
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        policy = get_or_create_policy(project)
        return Response(_serialize_policy(request, project.pk, policy))

    @extend_schema(
        summary="Set one signal's audience within its ceiling",
        request=SetAudienceSerializer,
        responses=SignalPrivacyPolicySerializer,
    )
    def patch(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        self._require_writer(project.pk)
        body = SetAudienceSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        policy = get_or_create_policy(project)
        policy = set_signal_audience(
            policy,
            body.validated_data["signal"],
            body.validated_data["audience"],
            actor=request.user,
        )
        return Response(_serialize_policy(request, project.pk, policy))


class SignalPrivacyRaiseCeilingView(_SignalPrivacyBase):
    """POST — raise (→ opens a team-ratification proposal) or lower (immediate) a ceiling."""

    @extend_schema(
        summary="Raise (team-ratified) or lower (immediate) a signal's ceiling",
        request=RaiseCeilingSerializer,
        responses={
            200: OpenApiResponse(SignalPrivacyPolicySerializer, description="Lower/no-op applied."),
            202: OpenApiResponse(
                CeilingProposalSerializer,
                description="Raise opened a ratification proposal (or ratified immediately).",
            ),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        self._require_writer(project.pk)
        body = RaiseCeilingSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        policy = get_or_create_policy(project)
        try:
            proposal = propose_or_apply_ceiling_change(
                policy,
                body.validated_data["signal"],
                body.validated_data["ceiling"],
                actor=request.user,
            )
        except CeilingProposalConflict as exc:
            return Response(
                {"code": exc.code, "detail": exc.detail}, status=status.HTTP_409_CONFLICT
            )
        if proposal is None:
            # A lower / no-op applied immediately — return the refreshed policy.
            policy = get_or_create_policy(project)
            return Response(_serialize_policy(request, project.pk, policy))
        # A raise opened a ratification proposal (still OPEN, or RATIFIED for a solo team).
        return Response(_serialize_proposal(proposal, request), status=status.HTTP_202_ACCEPTED)


class SignalPrivacyRatchetDownView(_SignalPrivacyBase):
    """POST — set every signal's audience to TEAM in one call (the SM panic button)."""

    @extend_schema(
        summary="Ratchet every signal's audience down to team-only",
        request=None,
        responses={200: OpenApiResponse(SignalPrivacyPolicySerializer)},
    )
    def post(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        self._require_writer(project.pk)
        policy = get_or_create_policy(project)
        policy = ratchet_down_to_team(policy, actor=request.user)
        return Response(_serialize_policy(request, project.pk, policy), status=status.HTTP_200_OK)


class SignalCeilingProposalListView(_SignalPrivacyBase):
    """GET — list ceiling-raise proposals (open + recently resolved).

    Every project member may read a proposal's governance aggregate (status, tally,
    threshold, to_ceiling, expiry). The per-voter ``votes`` detail is team-scoped and
    redacted for non-team readers by ``_serialize_proposal`` (ADR-0104 §2 / issue 1553).
    """

    # How many resolved proposals to surface alongside the open ones — the audit tail.
    _RESOLVED_LIMIT = 20

    @extend_schema(
        summary="List ceiling-raise ratification proposals (open + recent)",
        responses=CeilingProposalSerializer(many=True),
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        # Open first, then the most-recent resolved (audit tail). Prefetch votes so the
        # per-proposal tally/serialize reads hit the cache (no N+1 over votes).
        base = SignalCeilingRaiseProposal.objects.filter(project_id=project.pk).prefetch_related(
            "votes"
        )
        open_qs = list(base.filter(status=CeilingRaiseStatus.OPEN).order_by("-created_at"))
        resolved_qs = list(
            base.exclude(status=CeilingRaiseStatus.OPEN).order_by("-resolved_at")[
                : self._RESOLVED_LIMIT
            ]
        )
        # One roster fetch for the whole list (the roster is identical across a
        # project's proposals) — no per-proposal team-membership query.
        voter_ids = team_member_user_ids(project.pk)
        payload = [
            _serialize_proposal(p, request, voter_ids=voter_ids) for p in (*open_qs, *resolved_qs)
        ]
        return Response(payload)


class SignalCeilingProposalVoteView(_SignalPrivacyBase):
    """POST — cast or change a vote on an open ceiling-raise proposal (team members only)."""

    @extend_schema(
        summary="Vote on a ceiling-raise proposal",
        request=CeilingVoteRequestSerializer,
        responses={200: OpenApiResponse(CeilingProposalSerializer)},
    )
    def post(self, request: Request, project_pk: str, proposal_pk: str) -> Response:
        project = self._project(project_pk)
        # IDOR-safe: the proposal must belong to this project (404 otherwise).
        proposal = get_object_or_404(
            SignalCeilingRaiseProposal, pk=proposal_pk, project_id=project.pk
        )
        # Only an active team member may vote — a non-team project Admin/PM cannot
        # (Amendment A.2: the ratification is the team's, not management's).
        if not is_team_member(request.user, project.pk):
            raise PermissionDenied("Only a team member can vote on a signal-ceiling proposal.")
        body = CeilingVoteRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            proposal = cast_ceiling_vote(proposal.pk, request.user, body.validated_data["choice"])
        except CeilingProposalConflict as exc:
            return Response(
                {"code": exc.code, "detail": exc.detail}, status=status.HTTP_409_CONFLICT
            )
        return Response(_serialize_proposal(proposal, request))


class SignalCeilingProposalWithdrawView(_SignalPrivacyBase):
    """POST — withdraw an open proposal (the proposer or a facilitator/Admin cancels it)."""

    @extend_schema(
        summary="Withdraw an open ceiling-raise proposal",
        request=None,
        responses={200: OpenApiResponse(CeilingProposalSerializer)},
    )
    def post(self, request: Request, project_pk: str, proposal_pk: str) -> Response:
        project = self._project(project_pk)
        proposal = get_object_or_404(
            SignalCeilingRaiseProposal, pk=proposal_pk, project_id=project.pk
        )
        # Withdraw is the proposer's cancel; a facilitator/Admin may also clear it.
        is_proposer = (
            getattr(request.user, "is_authenticated", False)
            and proposal.proposed_by_id == request.user.pk
        )
        if not (is_proposer or _is_facilitator_or_admin(request, project.pk)):
            raise PermissionDenied(
                "Only the proposer or a facilitator/Admin can withdraw this proposal."
            )
        try:
            proposal = withdraw_ceiling_proposal(proposal.pk, request.user)
        except CeilingProposalConflict as exc:
            return Response(
                {"code": exc.code, "detail": exc.detail}, status=status.HTTP_409_CONFLICT
            )
        return Response(_serialize_proposal(proposal, request))
