"""Serializers for board share-link management (#283, ADR-0245).

The public board snapshot is built as a plain dict by
``share_services.serialize_public_board`` (a minimized, whitelisted shape), so it
has no serializer here — these cover only the authenticated management surface.
``token_hash`` is never exposed; only the non-revealing ``token_prefix`` is.
"""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.projects.models import ShareLink
from trueppm_api.apps.workspace.serializers import display_name_for


class ShareLinkSerializer(serializers.ModelSerializer[ShareLink]):
    """Read serializer for a share link in the management list.

    Deliberately omits ``token_hash`` (secret) — the raw token is only ever
    returned once, in the create response, via ``ShareLinkCreateResponseSerializer``.
    """

    created_by = serializers.SerializerMethodField()
    is_active = serializers.BooleanField(read_only=True)

    class Meta:
        model = ShareLink
        fields = [  # noqa: RUF012
            "id",
            "content_kind",
            "token_prefix",
            "label",
            "show_assignees",
            "created_by",
            "created_at",
            "revoked_at",
            "access_count",
            "last_accessed_at",
            "is_active",
        ]
        read_only_fields = fields

    def get_created_by(self, obj: ShareLink) -> str | None:
        user = obj.created_by
        if user is None:
            return None
        return display_name_for(user.first_name, user.last_name, user.username)


class ShareLinkCreateSerializer(serializers.Serializer[Any]):
    """Write serializer for minting a link. Both fields optional; safe defaults."""

    # ``label`` shadows DRF's ``Field.label`` attribute; the stub flags the
    # assignment though it is valid at runtime (same pattern as observability).
    label = serializers.CharField(  # type: ignore[assignment]
        max_length=120, required=False, allow_blank=True, default=""
    )
    show_assignees = serializers.BooleanField(required=False, default=False)


class ShareLinkCreateResponseSerializer(ShareLinkSerializer):
    """Create response: the full row plus the one-time raw token and its relative path.

    ``token`` and ``share_path`` are present ONLY on this response and never again —
    the web client composes the absolute URL from ``window.location.origin`` so the
    API stays decoupled from the frontend origin.
    """

    token = serializers.CharField(read_only=True)
    share_path = serializers.CharField(read_only=True)

    class Meta(ShareLinkSerializer.Meta):
        fields = [*ShareLinkSerializer.Meta.fields, "token", "share_path"]  # noqa: RUF012
        read_only_fields = fields
