"""Serializers for the profiles app (ADR-0129, ADR-0139)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.profiles.constants import HIDEABLE_VIEW_KEYS
from trueppm_api.apps.profiles.models import UserProfile


class UserProfileSerializer(serializers.ModelSerializer[UserProfile]):
    """Read/write the caller's own app preferences.

    ``default_landing`` and ``role_context`` choice validation is enforced by the
    model fields' ``choices`` (DRF rejects an out-of-range value with 400).
    ``hidden_views`` is a bounded list of canonical view keys (ADR-0139);
    ``validate_hidden_views`` rejects unknown keys and de-duplicates.
    ``schedule_in_deliver`` is a plain per-user placement opt-in (ADR-0203, #1645):
    a display-only boolean that additionally surfaces Schedule under Deliver.
    """

    # max_length on both the list and the child bound the payload so a worker can
    # never interpolate an attacker-supplied giant list into the error string
    # (same DoS guard as ProgramRollupConfigSerializer.enabled_kpis).
    hidden_views = serializers.ListField(
        child=serializers.CharField(max_length=32),
        max_length=32,
        required=False,
    )

    class Meta:
        model = UserProfile
        fields = ["default_landing", "role_context", "hidden_views", "schedule_in_deliver"]

    def validate_hidden_views(self, value: list[str]) -> list[str]:
        unknown = [v for v in value if v not in HIDEABLE_VIEW_KEYS]
        if unknown:
            preview = ", ".join(sorted(unknown)[:5])
            suffix = f" (+{len(unknown) - 5} more)" if len(unknown) > 5 else ""
            raise serializers.ValidationError(
                f"Unknown or non-hideable view key(s): {preview}{suffix}. "
                f"Expected one of: {', '.join(sorted(HIDEABLE_VIEW_KEYS))}."
            )
        # De-duplicate while preserving caller order — the hidden set is a set in
        # spirit; storing duplicates would be harmless but noisy.
        seen: set[str] = set()
        deduped: list[str] = []
        for v in value:
            if v not in seen:
                seen.add(v)
                deduped.append(v)
        return deduped

    def update(self, instance: UserProfile, validated_data: dict[str, Any]) -> UserProfile:
        update_fields: list[str] = []
        if "default_landing" in validated_data:
            instance.default_landing = validated_data["default_landing"]
            update_fields.append("default_landing")
        if "role_context" in validated_data:
            instance.role_context = validated_data["role_context"]
            update_fields.append("role_context")
        if "hidden_views" in validated_data:
            instance.hidden_views = validated_data["hidden_views"]
            update_fields.append("hidden_views")
        if "schedule_in_deliver" in validated_data:
            instance.schedule_in_deliver = validated_data["schedule_in_deliver"]
            update_fields.append("schedule_in_deliver")
        if update_fields:
            instance.save(update_fields=update_fields)
        return instance
