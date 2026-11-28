"""Response shapes of ``GET /sprints/<id>/commitment-status/`` (ADR-1485 D3, D10)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from .baseline_variance_views import DerivationRefSerializer


class AtRiskTaskSerializer(serializers.Serializer[dict[str, Any]]):
    """A committed task the last recalculation places after the sprint's end."""

    task_id = serializers.UUIDField()
    task_name = serializers.CharField()
    finish = serializers.DateField()
    working_days_after_sprint_end = serializers.IntegerField(
        allow_null=True,
        help_text="Working days from the sprint's end date to the task's finish.",
    )
    cause = serializers.CharField(allow_null=True)
    derivation_ref = DerivationRefSerializer(allow_null=True)


class OpenScopeChangeSerializer(serializers.Serializer[dict[str, Any]]):
    """A scope change still awaiting an accept or reject."""

    id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=["injection", "slip"])
    batch_id = serializers.UUIDField(allow_null=True)
    task_id = serializers.UUIDField(allow_null=True)
    task_name = serializers.CharField()
    requested_by = serializers.IntegerField(allow_null=True)
    requested_by_name = serializers.CharField(allow_null=True)
    requested_at = serializers.DateTimeField()
    age_seconds = serializers.IntegerField()
    proposed_start = serializers.DateField(allow_null=True)
    proposed_finish = serializers.DateField(allow_null=True)
    reason = serializers.CharField(allow_blank=True)


class SprintCommitmentStatusSerializer(serializers.Serializer[dict[str, Any]]):
    """The commitment-status envelope."""

    sprint_id = serializers.UUIDField()
    sprint_finish_date = serializers.DateField()
    at_risk_count = serializers.IntegerField()
    at_risk = AtRiskTaskSerializer(many=True)
    open_scope_change_count = serializers.IntegerField()
    oldest_open_age_seconds = serializers.IntegerField(allow_null=True)
    open_scope_changes = OpenScopeChangeSerializer(many=True)
    as_of = serializers.DateTimeField()
