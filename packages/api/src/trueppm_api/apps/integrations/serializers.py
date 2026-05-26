"""DRF serializers for the ``/me/credentials/`` viewset (ADR-0049 §3).

Three serializers, all built around the rule that the encrypted PAT
ciphertext is **never** rendered back to the client — not even to the
authenticated owner. The list response is intentionally a derived view
("does a row exist? when was it last used? when does it expire?"); read
of the underlying secret only happens server-side when the git-aware
tasks refresh endpoint (#637) needs it.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from rest_framework import serializers

from .models import IntegrationCredential
from .registry import TASK_LINK_PROVIDERS


class CredentialSummarySerializer(serializers.Serializer[Any]):
    """One row per provider in the list response.

    Surfaces:
    - ``provider`` (machine key) and ``name`` (human label) for the UI header
    - ``exists`` — drives the Connected / Not connected pill
    - ``base_url`` for self-hosted users
    - ``created_at`` / ``updated_at`` / ``last_used_at`` for the audit trail
    - ``expires_at`` for the "expires in X days" hint
    - ``requires_credential`` so the UI can hide the Connect button for the
      ``generic`` provider when no PAT is needed

    Notably absent: any field derived from ``secret_ciphertext``.
    """

    provider = serializers.CharField()
    name = serializers.CharField()
    exists = serializers.BooleanField()
    base_url = serializers.CharField(allow_blank=True, required=False)
    created_at = serializers.DateTimeField(allow_null=True)
    updated_at = serializers.DateTimeField(allow_null=True)
    last_used_at = serializers.DateTimeField(allow_null=True)
    expires_at = serializers.DateTimeField(allow_null=True)
    requires_credential = serializers.BooleanField()


class CredentialUpsertSerializer(serializers.Serializer[Any]):
    """Payload for ``POST /me/credentials/{provider}/`` (connect or rotate).

    Validation rules:
    - ``secret`` is required and non-empty (the encryption helper refuses
      empty plaintext anyway; rejecting here gives a clean 400).
    - ``secret`` is write-only — never echoed back.
    - ``base_url`` is optional. When present it must be an ``http://`` or
      ``https://`` URL; ``file://`` / ``javascript:`` / ``gopher://`` /
      similar schemes are rejected here. This serializer is the cheap first
      line of defense; the resolver-level SSRF guard (block RFC1918, link-local,
      cloud metadata at connect time) lands with #677's PAT verification in
      ``integrations.http`` and is reused by #637's git-link refresh.
    - ``expires_at`` is optional and informational only.
    """

    secret = serializers.CharField(
        write_only=True, min_length=1, max_length=4096, trim_whitespace=False
    )
    base_url = serializers.CharField(required=False, allow_blank=True, max_length=512)
    expires_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate_secret(self, value: str) -> str:
        # trim_whitespace=False above lets us catch the all-whitespace case
        # explicitly so the error message is clear.
        if not value.strip():
            raise serializers.ValidationError("Secret must not be blank.")
        return value

    def validate_base_url(self, value: str) -> str:
        if not value:
            return value
        if "://" not in value:
            raise serializers.ValidationError(
                "Host URL must include a scheme (https://example.com)."
            )
        parsed = urlparse(value)
        if parsed.scheme.lower() not in ("http", "https"):
            raise serializers.ValidationError(
                f"Host URL scheme {parsed.scheme.lower()!r} is not allowed. Use http or https."
            )
        # A host URL is a base — a path (self-hosted GitLab relative root, e.g.
        # https://example.com/gitlab) is fine, but a query string or fragment is
        # never meaningful and would corrupt the constructed ``…/api/v4/user``
        # verify URL (e.g. https://host#frag/api/v4/user). Reject them here.
        if parsed.query or parsed.fragment:
            raise serializers.ValidationError(
                "Host URL must not contain a query string or fragment."
            )
        return value


class CredentialVerificationErrorSerializer(serializers.Serializer[Any]):
    """422 body when live PAT verification fails (#677).

    Documents the shape the Connected Accounts page reads on a rejected
    connect/rotate: a human ``detail``, the stable ``code``
    ``provider_verification_failed``, and a machine-readable ``reason`` the
    client can branch on (``invalid_token``, ``provider_unreachable``,
    ``provider_timeout``, ``blocked_host``).
    """

    detail = serializers.CharField()
    code = serializers.CharField()
    reason = serializers.CharField(allow_null=True)


def serialize_credential_summaries(
    user: Any,
    queryset: list[IntegrationCredential],
) -> list[dict[str, Any]]:
    """Build the list-response payload for ``GET /me/credentials/``.

    Iterates the registered providers (so the response always includes one
    entry per provider, whether the user has a row or not) and joins the
    user's existing rows by ``provider`` key. This is the shape the
    Connected Accounts page consumes — it never has to reason about
    "missing rows" vs "no providers registered."
    """
    rows_by_provider: dict[str, IntegrationCredential] = {row.provider: row for row in queryset}
    out: list[dict[str, Any]] = []
    for key in TASK_LINK_PROVIDERS:
        handler = TASK_LINK_PROVIDERS.get(key)
        if handler is None:  # pragma: no cover — keys() iterates known
            continue
        row = rows_by_provider.get(key)
        out.append(
            {
                "provider": key,
                "name": getattr(handler, "label", key),
                "exists": row is not None,
                "base_url": row.base_url if row else "",
                "created_at": row.created_at if row else None,
                "updated_at": row.updated_at if row else None,
                "last_used_at": row.last_used_at if row else None,
                "expires_at": row.expires_at if row else None,
                "requires_credential": getattr(handler, "requires_credential", True),
            }
        )
    return out
