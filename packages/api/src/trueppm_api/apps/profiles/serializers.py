"""Serializers for the profiles app (ADR-0129)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.profiles.models import UserProfile


class UserProfileSerializer(serializers.ModelSerializer[UserProfile]):
    """Read/write the caller's own app preferences.

    Only ``default_landing`` is writable. Choice validation is enforced by the
    model field's ``choices`` (DRF rejects an out-of-range value with 400).
    """

    class Meta:
        model = UserProfile
        fields = ["default_landing"]

    def update(self, instance: UserProfile, validated_data: dict[str, Any]) -> UserProfile:
        instance.default_landing = validated_data.get("default_landing", instance.default_landing)
        instance.save(update_fields=["default_landing"])
        return instance
