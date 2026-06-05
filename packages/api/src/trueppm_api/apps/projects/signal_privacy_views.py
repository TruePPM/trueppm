"""Signal-privacy policy endpoints (ADR-0104 §1.1).

Surface:
  GET   /api/v1/projects/<project_pk>/signal-privacy/             — read posture
  PATCH /api/v1/projects/<project_pk>/signal-privacy/             — set one audience
  POST  /api/v1/projects/<project_pk>/signal-privacy/raise_ceiling/
  POST  /api/v1/projects/<project_pk>/signal-privacy/ratchet_down/

Two write gates (ADR-0104 §1.1):
  * set-audience / ratchet  — the facilitator's dial (Scrum-Master facet, ADR-0078
    / #927) OR a project Admin (role >= ADMIN). Bounded by the ceiling, so it can
    never widen exposure past what the team authorized.
  * raise-ceiling           — the team-owned act. 0.3 ships it gated to the
    facilitator OR role >= ADMIN, audited + team-visible (the genuine team vote is
    the 0.4 follow-up #930). Lowering a ceiling is part of set/raise and always
    allowed (more private).
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
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
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
)
from trueppm_api.apps.projects.signal_privacy_services import (
    SIGNAL_KEYS,
    get_or_create_policy,
    raise_signal_ceiling,
    ratchet_down_to_team,
    requester_signal_tier,
    set_signal_audience,
)
from trueppm_api.apps.teams.services import has_team_facet

# ---------------------------------------------------------------------------
# Serializers (declared here; drf-spectacular discovers them for the schema)
# ---------------------------------------------------------------------------


class _SignalPairSerializer(serializers.Serializer[Any]):
    audience = serializers.ChoiceField(choices=SignalAudience.choices)
    ceiling = serializers.ChoiceField(choices=SignalAudience.choices)


class SignalPrivacyPolicySerializer(serializers.Serializer[Any]):
    """Read shape: the resolved per-signal posture + what the requester may do."""

    signals = serializers.DictField(child=_SignalPairSerializer())
    requester_tier = serializers.ChoiceField(choices=SignalAudience.choices, allow_null=True)
    can_set_audience = serializers.BooleanField()
    can_raise_ceiling = serializers.BooleanField()


class SetAudienceSerializer(serializers.Serializer[Any]):
    """PATCH body — move one signal's audience within [TEAM, ceiling]."""

    signal = serializers.ChoiceField(choices=[(k, k) for k in SIGNAL_KEYS])
    audience = serializers.ChoiceField(choices=SignalAudience.choices)


class RaiseCeilingSerializer(serializers.Serializer[Any]):
    """POST body — set one signal's ceiling (the team-owned authorization)."""

    signal = serializers.ChoiceField(choices=[(k, k) for k in SIGNAL_KEYS])
    ceiling = serializers.ChoiceField(choices=SignalAudience.choices)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _is_facilitator_or_admin(request: Request, project_id: Any) -> bool:
    """Facilitator (Scrum-Master facet) OR project Admin — the 0.3 write gate."""
    role = _membership_role(request, project_id)
    if role is not None and role >= Role.ADMIN:
        return True
    return has_team_facet(request.user, project_id, "is_scrum_master")


def _serialize_policy(
    request: Request, project_id: Any, policy: ProjectSignalPrivacyPolicy
) -> dict[str, Any]:
    tier = requester_signal_tier(request, project_id)
    # The write gate is "facilitator (TEAM_SM) or admin (TEAM_SM_PM)" — exactly the
    # top two reader tiers — so derive it from the already-resolved tier rather than
    # issuing a second has_team_facet query (perf).
    can_write = tier in (SignalAudience.TEAM_SM, SignalAudience.TEAM_SM_PM)
    return {
        "signals": {key: policy.resolved(key) for key in SIGNAL_KEYS},
        "requester_tier": tier,
        # set-audience and the 0.3 raise-ceiling share the same interim gate; they
        # diverge at the 0.4 team-vote (#930), so they are reported separately now.
        "can_set_audience": can_write,
        "can_raise_ceiling": can_write,
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
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied(
                "Only the Scrum Master or a project Admin can change signal privacy."
            )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class SignalPrivacyPolicyView(_SignalPrivacyBase):
    """GET the posture; PATCH one signal's audience (within its ceiling)."""

    @extend_schema(responses=SignalPrivacyPolicySerializer)
    def get(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        policy = get_or_create_policy(project)
        return Response(_serialize_policy(request, project.pk, policy))

    @extend_schema(request=SetAudienceSerializer, responses=SignalPrivacyPolicySerializer)
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
    """POST — raise (or lower) one signal's team-authorized ceiling."""

    @extend_schema(request=RaiseCeilingSerializer, responses=SignalPrivacyPolicySerializer)
    def post(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        self._require_writer(project.pk)
        body = RaiseCeilingSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        policy = get_or_create_policy(project)
        policy = raise_signal_ceiling(
            policy,
            body.validated_data["signal"],
            body.validated_data["ceiling"],
            actor=request.user,
        )
        return Response(_serialize_policy(request, project.pk, policy))


class SignalPrivacyRatchetDownView(_SignalPrivacyBase):
    """POST — set every signal's audience to TEAM in one call (the SM panic button)."""

    @extend_schema(
        request=None,
        responses={200: OpenApiResponse(SignalPrivacyPolicySerializer)},
    )
    def post(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        self._require_writer(project.pk)
        policy = get_or_create_policy(project)
        policy = ratchet_down_to_team(policy, actor=request.user)
        return Response(_serialize_policy(request, project.pk, policy), status=status.HTTP_200_OK)
