"""Read-only serializer for the team-readable agent-action log (ADR-0112 §1.3)."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.agents.models import AgentAction


class AgentActionSerializer(serializers.ModelSerializer[AgentAction]):
    """Team-facing view of one audited agent action.

    Read-only — ``AgentAction`` rows are append-only and never mutated through the API.
    Exposes the chain fields (``sequence``, ``record_hash``) for transparency; they are
    integrity anchors, not secrets. Never exposes token material — only the 8-char
    ``actor_token_prefix``.
    """

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
            "engine_version",
            "payload_hash",
            "record_hash",
            "summary",
            "occurred_at",
        ]
        read_only_fields = fields
