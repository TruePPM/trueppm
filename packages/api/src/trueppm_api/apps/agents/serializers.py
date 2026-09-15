"""Read-only serializer for the team-readable agent-action log (ADR-0112 §1.3)."""

from __future__ import annotations

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionRefusalDetail,
    AgentActionRefusalReason,
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
