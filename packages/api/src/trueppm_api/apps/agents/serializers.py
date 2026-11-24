"""Read-only serializer for the team-readable agent-action log (ADR-0112 §1.3)."""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionRefusalDetail,
    AgentActionRefusalReason,
    AgentActionVerdict,
    AgentActorKind,
)


class AgentActionRefusalDetailSerializer(serializers.ModelSerializer[AgentActionRefusalDetail]):
    """The non-hashed refusal telemetry attached to a refused action (ADR-0421, #1850)."""

    class Meta:
        model = AgentActionRefusalDetail
        fields = ["constraint", "projected_impact"]
        read_only_fields = fields


class AgentActionSerializer(serializers.ModelSerializer[AgentAction]):
    """Team-facing view of one audited agent action.

    Read-only — ``AgentAction`` rows are append-only and never mutated through the API.
    Exposes the chain fields (``sequence``, ``record_hash``) for transparency; they are
    integrity anchors, not secrets. Never exposes token material — only the 8-char
    ``actor_token_prefix``. ``refusal_detail`` is the non-hashed side-car telemetry
    (constraint that fired + projected impact); ``null`` for allowed actions and for
    refusals recorded before a constraint was wired.
    """

    # Declared explicitly (like refusal_detail below) rather than left to
    # ModelSerializer's auto-build from Meta.read_only_fields: DRF's
    # include_extra_kwargs() strips allow_blank from any field once
    # read_only_fields forces read_only=True, so the auto-built field never
    # tells drf-spectacular that "" is a real, expected value — and the
    # published AgentActionRefusalReasonEnum schema silently disagreed with
    # every allowed-verdict row (schemathesis, job #16501510109 / #3811). An
    # explicitly-declared field bypasses that stripping entirely.
    refusal_reason = serializers.ChoiceField(
        choices=AgentActionRefusalReason.choices,
        allow_blank=True,
        read_only=True,
        help_text="Set (identity|policy) when verdict=refused; empty otherwise.",
    )
    refusal_detail = serializers.SerializerMethodField()

    class Meta:
        model = AgentAction
        fields = [
            "id",
            "schema_version",
            "sequence",
            "actor_kind",
            "actor_token_prefix",
            "principal",
            "action",
            "method",
            "object_type",
            "object_id",
            "project",
            "capability_used",
            "verdict",
            "refusal_reason",
            "refusal_detail",
            "engine_version",
            "payload_hash",
            "record_hash",
            "summary",
            "occurred_at",
        ]
        read_only_fields = fields

    @extend_schema_field(AgentActionRefusalDetailSerializer(allow_null=True))
    def get_refusal_detail(self, obj: AgentAction) -> dict[str, object] | None:
        # Reverse OneToOne: absent for allowed actions (and constraint-less refusals).
        # Accessing a missing reverse o2o raises, so catch rather than getattr-default.
        try:
            detail = obj.refusal_detail
        except AgentActionRefusalDetail.DoesNotExist:
            return None
        return AgentActionRefusalDetailSerializer(detail).data


class AgentPersonSerializer(serializers.Serializer[Any]):
    """A person named on the Agents page (principal, or who paused)."""

    id = serializers.IntegerField()
    name = serializers.CharField()


class AgentPauseSerializer(serializers.Serializer[Any]):
    """Pause state, for people. The agent itself is only ever told it is paused."""

    paused_at = serializers.DateTimeField()
    paused_by = AgentPersonSerializer(allow_null=True)


class AgentLastActionSerializer(serializers.Serializer[Any]):
    """The agent's latest call, redacted to what the viewer can read."""

    occurred_at = serializers.DateTimeField()
    verdict = serializers.ChoiceField(choices=AgentActionVerdict.choices)
    summary = serializers.CharField(help_text="Empty when the action's project is not readable.")
    redacted = serializers.BooleanField()


class AgentProgramSerializer(serializers.Serializer[Any]):
    """A program the agent acted in that the viewer can see (links to its agents page)."""

    id = serializers.UUIDField()
    name = serializers.CharField()


class AgentSerializer(serializers.Serializer[Any]):
    """One agent on the workspace Agents page (#4814, #4757).

    ``scope`` is the stored grant; ``effective_scope`` is that grant intersected with
    what the principal can do right now, which is what the server enforces. Each maps
    every area to one of ``none``, ``read``, ``propose`` (shown as "Dry run") or
    ``write`` (never present in 0.5).
    """

    id = serializers.UUIDField()
    name = serializers.CharField()
    token_prefix = serializers.CharField()
    principal = AgentPersonSerializer()
    created_at = serializers.DateTimeField()
    last_used_at = serializers.DateTimeField(allow_null=True)
    expires_at = serializers.DateTimeField(allow_null=True)
    revoked_at = serializers.DateTimeField(allow_null=True)
    paused = AgentPauseSerializer(allow_null=True)
    scope = serializers.DictField(child=serializers.CharField())
    effective_scope = serializers.DictField(child=serializers.CharField())
    last_action = AgentLastActionSerializer(allow_null=True)
    refusals_7d = serializers.IntegerField(
        help_text="Refused calls in the last 7 days, counting only actions the viewer can see."
    )
    programs = AgentProgramSerializer(many=True)
    can_manage = serializers.BooleanField()


class AgentListResponseSerializer(serializers.Serializer[Any]):
    """``GET /agents/``: the agents plus the scope vocabulary the matrix renders."""

    agents = AgentSerializer(many=True)
    truncated = serializers.BooleanField(
        help_text="True when more agents exist than the list carries (the list is capped)."
    )
    areas = serializers.ListField(child=serializers.DictField(child=serializers.CharField()))
    grantable_levels = serializers.ListField(child=serializers.CharField())
    can_verify_log = serializers.BooleanField(
        help_text=(
            "True for a workspace Admin, who may call GET /agents/audit-verify/. The page "
            "omits the action-log verified line for everyone else."
        )
    )


class AgentActionSummarySerializer(serializers.Serializer[Any]):
    """One recent action in an agent's detail panel, redacted by project membership."""

    id = serializers.UUIDField()
    occurred_at = serializers.DateTimeField()
    actor_kind = serializers.ChoiceField(choices=AgentActorKind.choices)
    action = serializers.CharField()
    verdict = serializers.ChoiceField(choices=AgentActionVerdict.choices)
    constraint = serializers.CharField(allow_blank=True)
    summary = serializers.CharField(allow_blank=True)
    redacted = serializers.BooleanField()


class AgentDetailSerializer(AgentSerializer):
    """``GET /agents/{id}/``: the row plus recent actions."""

    recent_actions = AgentActionSummarySerializer(many=True)


class AgentControlRequestSerializer(serializers.Serializer[Any]):
    """Body of pause / resume / revoke."""

    reason = serializers.CharField(required=False, allow_blank=True, max_length=500)


class AgentScopeEditSerializer(serializers.Serializer[Any]):
    """Body of ``PATCH /agents/{id}/scope/`` — areas left out keep their level."""

    scope = serializers.DictField(child=serializers.CharField())
    reason = serializers.CharField(required=False, allow_blank=True, max_length=500)


class AgentAuditVerifySerializer(serializers.Serializer[Any]):
    """The "Action log verified" line: the ``audit_verify`` result, cached briefly."""

    ok = serializers.BooleanField()
    record_count = serializers.IntegerField()
    checked_at = serializers.DateTimeField()
    anchor = serializers.CharField()
    break_sequence = serializers.IntegerField(allow_null=True)
