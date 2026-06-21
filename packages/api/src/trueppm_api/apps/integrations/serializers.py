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

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import URLValidator
from rest_framework import serializers

from .models import IntegrationCredential, TaskLink
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


class TaskLinkSerializer(serializers.ModelSerializer[TaskLink]):
    """A git/PM link on a task (ADR-0049 §3, #637; redesign #970).

    Client-writable: ``url``, ``custom_title``, ``labels``, ``display_order``.
    ``provider`` is resolved server-side from the URL + the user's connected
    hosts, and ``status``/``title``/``fetched_at`` are populated by the refresh
    endpoint — never trusted from the client. ``server_version`` is exposed so
    offline clients can reconcile against the sync delta.
    """

    # Declared as a plain CharField (not the auto ModelSerializer URLField) so a
    # bare host like "github.com/acme/api" survives field validation and reaches
    # ``validate_url``, which prepends the scheme before validating (#970). A
    # strict URLField would 400 it before normalization could run.
    url = serializers.CharField(max_length=2048, trim_whitespace=True)
    # Optional free-text tags; entries are trimmed/de-duped/capped in
    # ``validate_labels``. ``allow_blank`` on the child so a stray "" is dropped
    # rather than 400-ing the whole request.
    labels = serializers.ListField(
        child=serializers.CharField(max_length=40, allow_blank=True),
        required=False,
    )

    class Meta:
        model = TaskLink
        fields = [
            "id",
            "url",
            "provider",
            "title",
            "custom_title",
            "labels",
            "status",
            "fetched_at",
            "display_order",
            "server_version",
        ]
        read_only_fields = [
            "id",
            "provider",
            "title",
            "status",
            "fetched_at",
            "server_version",
        ]

    def validate_url(self, value: str) -> str:
        """Normalize a scheme-less URL to ``https://`` then validate (#970).

        Users routinely paste a bare ``github.com/acme/api/pull/5`` — prepend
        ``https://`` rather than reject it. Anything with an explicit scheme is
        left as-is so a deliberate ``ftp://`` / ``javascript:`` is still caught
        by the http(s)-only ``URLValidator``. The resolver-level SSRF guard runs
        separately at refresh time when the URL is actually fetched.
        """
        raw = (value or "").strip()
        if not raw:
            raise serializers.ValidationError("Enter a URL.")
        if "://" not in raw:
            raw = "https://" + raw.lstrip("/")
        try:
            URLValidator(schemes=["http", "https"])(raw)
        except DjangoValidationError:
            raise serializers.ValidationError("Enter a valid http(s) web address.") from None
        return raw

    def validate_labels(self, value: list[str]) -> list[str]:
        """Trim, drop blanks, de-dupe (case-insensitive), and cap at 12 (#970)."""
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in value:
            label = (raw or "").strip()
            if not label:
                continue
            key = label.casefold()
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(label)
        if len(cleaned) > 12:
            raise serializers.ValidationError("A link can have at most 12 labels.")
        return cleaned

    def validate_custom_title(self, value: str) -> str:
        return (value or "").strip()


class TaskLinkCredentialRequiredSerializer(serializers.Serializer[Any]):
    """422 body when refresh needs a PAT the caller hasn't connected (#637).

    Lets the task-detail UI swap the status badge for a "Connect {provider}"
    affordance pointing at ``/me/settings/connected-accounts`` instead of
    leaving the link stuck at ``unknown``.
    """

    detail = serializers.CharField()
    code = serializers.CharField()
    provider = serializers.CharField()
    requires_credential = serializers.BooleanField()


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


class GitAutomationConfigSerializer(serializers.Serializer[Any]):
    """Read view of a project's Git-event card automation (#329, ADR-0158).

    Never renders the secret — only whether one is set. ``webhook_url`` is the
    per-project endpoint the admin pastes into GitHub/GitLab; the secret travels
    in the provider's signature header, never in the URL.
    """

    enabled = serializers.BooleanField()
    secret_set = serializers.BooleanField()
    webhook_url = serializers.CharField()
    configured_by = serializers.UUIDField(allow_null=True)
    secret_set_at = serializers.DateTimeField(allow_null=True)
    updated_at = serializers.DateTimeField(allow_null=True)


class GitAutomationUpdateSerializer(serializers.Serializer[Any]):
    """Write payload for toggling Git-event automation (project-admin only)."""

    enabled = serializers.BooleanField()
