"""User-scoped external-source connection endpoints (ADR-0097 §3).

``GET/PUT/DELETE /api/v1/me/connections/<source>/`` — the personal, self-scoped
surface for connecting a read-only external task source (e.g. the user's own
Jira Cloud account) so its assigned items appear in My Work.

Isolation & security posture (ADR-0097 §3 / §Threat Model → Resolution):
- **Strictly personal.** Every read/write filters ``user=request.user``; no
  project member, Admin, or Owner can see or touch another user's connection.
- **Secret never serialized.** The Fernet-encrypted PAT (``secret_ciphertext``)
  is never returned — the summary exposes only ``{source, exists, base_url,
  account_email, status, last_synced_at, config}``.
- **SSRF collapsed at connect.** ``base_url`` is Jira-Cloud-allow-listed
  (``providers.assert_base_url_allowed`` → ``*.atlassian.net``, https) *before*
  the token is ever put on the wire in the verify ping (#902 ordering).

This surface reuses ``IntegrationCredential`` (ADR-0097 §2) with the row's
``config`` carrying ``{account_email, jql, project_keys, status}``. It does
**not** call ``IntegrationCredential.upsert`` — that validates ``provider``
against ``TASK_LINK_PROVIDERS`` (where ``jira`` is reserved Enterprise), whereas
an external source validates against the distinct ``EXTERNAL_TASK_SOURCES``
registry. Persistence therefore goes through this module's own
``update_or_create`` + ``encrypt_secret``.

Scope note (#1418): this ticket ships the data layer + connection management.
The actual pull worker (Celery + ``ExternalSyncRequest`` outbox), the
``POST .../sync/`` trigger, and the My Work augmentation ride on top in #1419;
this module deliberately does not enqueue a sync.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast
from urllib.parse import urlparse

from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle, ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

from . import providers
from .encryption import encrypt_secret
from .external_sources import EXTERNAL_TASK_SOURCES, ExternalTaskSource
from .models import IntegrationCredential

if TYPE_CHECKING:
    from django.contrib.auth.models import User
    from rest_framework.request import Request

# Connection lifecycle status surfaced to the owner (ADR-0097 §5). Written by the
# #1419 pull worker into ``config["status"]``; this module only reads it and
# defaults a freshly-connected row to ``connected``.
STATUS_CONNECTED = "connected"
STATUS_NOT_CONNECTED = "not_connected"
STATUS_AUTH_FAILED = "auth_failed"

# Human-readable 422 detail per ``VerifyResult.reason`` (mirrors the credentials
# viewset map, plus the Jira-specific ``missing_email``).
_VERIFY_FAILURE_DETAIL: dict[str | None, str] = {
    "invalid_token": (
        "The source rejected this credential. Check the API token is valid, "
        "unexpired, and paired with the correct account email."
    ),
    "missing_email": "This source needs the account email that owns the API token.",
    "provider_unreachable": "Could not reach the source to verify this credential. Try again.",
    "provider_timeout": "Verifying this credential with the source timed out. Try again.",
    "blocked_host": "The host URL is not allowed — it must be a Jira Cloud (*.atlassian.net) host.",
}


class ExternalConnectionUpsertSerializer(serializers.Serializer[Any]):
    """Payload for ``PUT /me/connections/{source}/`` (connect or update).

    ``secret`` is the user's own API token (write-only, never echoed).
    ``base_url`` is the source host (Jira Cloud ``https://<tenant>.atlassian.net``),
    allow-listed downstream. ``account_email`` + ``jql`` + ``project_keys`` are
    stored in the credential's ``config`` — the source reads them at pull time.
    """

    secret = serializers.CharField(
        write_only=True, min_length=1, max_length=4096, trim_whitespace=False
    )
    base_url = serializers.CharField(max_length=512)
    account_email = serializers.EmailField(required=False, allow_blank=True, default="")
    jql = serializers.CharField(required=False, allow_blank=True, max_length=1024, default="")
    project_keys = serializers.ListField(
        child=serializers.CharField(max_length=64),
        required=False,
        default=list,
        max_length=50,
    )

    def validate_secret(self, value: str) -> str:
        if not value.strip():
            raise serializers.ValidationError("Secret must not be blank.")
        return value

    def validate_base_url(self, value: str) -> str:
        if "://" not in value:
            raise serializers.ValidationError(
                "Host URL must include a scheme (https://tenant.atlassian.net)."
            )
        parsed = urlparse(value)
        # https-only (ADR-0097 §Resolution #1): an external source ships a personal
        # token to base_url, so the transport must be encrypted. ``_jira_origin``
        # also forces https at request time; rejecting here keeps the stored value
        # spec-compliant rather than silently upgrading a cosmetic ``http://``.
        if parsed.scheme.lower() != "https":
            raise serializers.ValidationError(
                f"Host URL scheme {parsed.scheme.lower()!r} is not allowed. Use https."
            )
        if parsed.query or parsed.fragment:
            raise serializers.ValidationError(
                "Host URL must not contain a query string or fragment."
            )
        return value


class ExternalConnectionSummarySerializer(serializers.Serializer[Any]):
    """Owner-facing summary of a connection — **never** the secret (ADR-0097 §3).

    The ``source`` key is intentionally not echoed: the caller already has it from
    the ``/me/connections/{source}/`` request path, and a serializer field literally
    named ``source`` collides with DRF's internal ``Field.source`` attribute.
    """

    name = serializers.CharField()
    exists = serializers.BooleanField()
    base_url = serializers.CharField(allow_blank=True)
    account_email = serializers.CharField(allow_blank=True)
    status = serializers.CharField()
    last_synced_at = serializers.DateTimeField(allow_null=True)
    jql = serializers.CharField(allow_blank=True)
    project_keys = serializers.ListField(child=serializers.CharField())


class ExternalConnectionErrorSerializer(serializers.Serializer[Any]):
    """422 body when credential verification against the source fails."""

    detail = serializers.CharField()
    code = serializers.CharField()
    reason = serializers.CharField(allow_null=True)


def _summary(label: str, row: IntegrationCredential | None) -> dict[str, Any]:
    """Build the owner-facing summary dict for one source (secret excluded)."""
    cfg = (row.config if row else None) or {}
    return {
        "name": label,
        "exists": row is not None,
        "base_url": row.base_url if row else "",
        "account_email": cfg.get("account_email", ""),
        # Freshly-connected rows read ``connected``; the #1419 worker flips this to
        # ``auth_failed`` on a 401/403 so My Work can show a "Reconnect" prompt.
        "status": cfg.get("status") or (STATUS_CONNECTED if row else STATUS_NOT_CONNECTED),
        # ``last_used_at`` is stamped by the pull worker when it last used the token.
        "last_synced_at": row.last_used_at if row else None,
        "jql": cfg.get("jql", ""),
        "project_keys": cfg.get("project_keys", []),
    }


@extend_schema(tags=["me"])
class ExternalConnectionView(IdempotencyMixin, APIView):
    """Manage the authenticated user's connection to one external task source.

    Routes (``<source>`` is an ``EXTERNAL_TASK_SOURCES`` key, e.g. ``jira``):
        GET    /api/v1/me/connections/{source}/   summary (exists / status / config)
        PUT    /api/v1/me/connections/{source}/   connect or update (verify then store)
        DELETE /api/v1/me/connections/{source}/   disconnect (hard-remove ciphertext)

    All actions require authentication and are self-scoped to ``request.user`` —
    the ``(user, provider)`` filter is the single IDOR boundary, so another
    user's connection is invisible by construction.
    """

    # Plain (non-ClassVar) annotations: DRF's APIView declares these as instance
    # attributes, so overriding them with a ClassVar trips mypy; noqa the RUF012
    # mutable-default lint that the ``views.py`` per-file ignore doesn't reach here.
    permission_classes: list[type[BasePermission]] = [IsAuthenticated]  # noqa: RUF012
    # Share the credential-store rate bucket — connect verifies against the source
    # (an outbound call) and all actions touch the encrypted credential store.
    throttle_classes: list[type[BaseThrottle]] = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "credential_rotate"

    def _resolve_source(self, source: str) -> type[ExternalTaskSource] | None:
        return EXTERNAL_TASK_SOURCES.get(source)

    def _user(self, request: Request) -> User:
        """Narrow ``request.user`` to the authenticated user for the ORM filter.

        ``IsAuthenticated`` guarantees a real user before any handler runs, so the
        ``AnonymousUser`` arm of ``request.user`` is unreachable here — the cast
        just tells the type-checker what the permission already enforced.
        """
        return cast("User", request.user)

    def _row(self, request: Request, source: str) -> IntegrationCredential | None:
        return IntegrationCredential.objects.filter(
            user=self._user(request), provider=source
        ).first()

    @extend_schema(responses={200: ExternalConnectionSummarySerializer})
    def get(self, request: Request, source: str) -> Response:
        source_cls = self._resolve_source(source)
        if source_cls is None:
            return Response(
                {"detail": f"Unknown external task source {source!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        row = self._row(request, source)
        payload = _summary(getattr(source_cls, "label", source), row)
        return Response(ExternalConnectionSummarySerializer(payload).data)

    @extend_schema(
        request=ExternalConnectionUpsertSerializer,
        responses={
            200: ExternalConnectionSummarySerializer,
            422: ExternalConnectionErrorSerializer,
        },
    )
    def put(self, request: Request, source: str) -> Response:
        """Connect or update the connection: allow-list host, verify, then store.

        Order matters (#902): the ``base_url`` host is allow-listed *before*
        ``verify_credential`` ships the token to it, so an attacker-controlled
        host is rejected before the PAT is on the wire. On a failed verify the
        plaintext is never written — ``encrypt_secret`` is not reached.
        """
        source_cls = self._resolve_source(source)
        if source_cls is None:
            return Response(
                {"detail": f"Unknown external task source {source!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = ExternalConnectionUpsertSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        secret: str = data["secret"]
        base_url: str = data["base_url"]

        # Gate the host BEFORE verify: verify sends the token to base_url.
        try:
            providers.assert_base_url_allowed(source, base_url)
        except providers.BaseUrlNotAllowed as exc:
            return Response(
                {"detail": str(exc), "code": "base_url_not_allowed"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        config: dict[str, Any] = {
            "account_email": data.get("account_email", ""),
            "jql": data.get("jql", ""),
            "project_keys": data.get("project_keys", []),
            "status": STATUS_CONNECTED,
        }

        result = source_cls().verify_credential(base_url=base_url, secret=secret, config=config)
        if not result.ok:
            return Response(
                {
                    "detail": _VERIFY_FAILURE_DETAIL.get(
                        result.reason, f"Could not verify the credential with {source}."
                    ),
                    "code": "source_verification_failed",
                    "reason": result.reason,
                },
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        # Persist directly (not IntegrationCredential.upsert — that validates the
        # provider against TASK_LINK_PROVIDERS, which reserves ``jira`` for
        # Enterprise; external sources use the EXTERNAL_TASK_SOURCES namespace).
        row, _ = IntegrationCredential.objects.update_or_create(
            user=self._user(request),
            provider=source,
            defaults={
                "secret_ciphertext": encrypt_secret(secret),
                "base_url": base_url,
                "config": config,
            },
        )
        payload = _summary(getattr(source_cls, "label", source), row)
        return Response(
            ExternalConnectionSummarySerializer(payload).data, status=status.HTTP_200_OK
        )

    @extend_schema(responses={204: None})
    def delete(self, request: Request, source: str) -> Response:
        """Disconnect: hard-remove the ciphertext, config, and cached items.

        Idempotent — a 204 whether or not a row existed (ADR-0097 §Resolution #2:
        "owner-only delete hard-removes ciphertext"). ``ExternalWorkItem`` FKs to
        ``user`` (not the credential), so deleting the credential does not cascade
        the cache — the cached items are removed explicitly here so a disconnect
        leaves no residual external data in My Work.
        """
        source_cls = self._resolve_source(source)
        if source_cls is None:
            return Response(
                {"detail": f"Unknown external task source {source!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        from .models import ExternalWorkItem

        user = self._user(request)
        IntegrationCredential.objects.filter(user=user, provider=source).delete()
        ExternalWorkItem.objects.filter(user=user, source=source).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
