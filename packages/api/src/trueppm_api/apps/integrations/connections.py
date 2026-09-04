"""User-scoped external-source connection endpoints (ADR-0097 §3).

``GET/PUT/PATCH/DELETE /api/v1/me/connections/<source>/`` — the personal, self-scoped
surface for connecting a read-only external task source (e.g. the user's own
Jira Cloud account) so its assigned items appear in My Work.

Isolation & security posture (ADR-0097 §3 / §Threat Model → Resolution):
- **Strictly personal.** Every read/write filters ``user=request.user``; no
  project member, Admin, or Owner can see or touch another user's connection.
- **Secret never serialized.** The Fernet-encrypted PAT (``secret_ciphertext``)
  is never returned — the summary exposes only ``{source, exists, base_url,
  account_email, status, last_synced_at, jql, project_keys, poll_enabled,
  last_sync}``. The stored ``config`` is never echoed wholesale; every key it
  contributes is projected explicitly (see :func:`last_sync_summary`).
- **SSRF collapsed at connect.** ``base_url`` is Jira-Cloud-allow-listed
  (``providers.assert_base_url_allowed`` → ``*.atlassian.net``, https) *before*
  the token is ever put on the wire in the verify ping (#902 ordering).

This surface reuses ``IntegrationCredential`` (ADR-0097 §2) with the row's
``config`` carrying ``{account_email, jql, project_keys, poll_enabled, status}``
— both ``jql`` and ``project_keys`` are read by the source at pull time, the
latter ANDed onto the query so it can only narrow what leaves the provider
(#2888). It does
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

from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import generics, pagination, serializers, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle, ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.core.openapi import state_refusal_400

from . import providers
from .encryption import encrypt_secret
from .external_sources import (
    DEPLOYMENT_CLOUD,
    EXTERNAL_TASK_SOURCES,
    JIRA_DEPLOYMENTS,
    JIRA_PROJECT_KEY_RE,
    ExternalTaskSource,
    JqlNotWellFormed,
    scan_jql,
)
from .models import ExternalWorkItem, IntegrationCredential
from .services import SyncCooldownActive, enqueue_external_sync

if TYPE_CHECKING:
    from django.contrib.auth.models import User
    from rest_framework.request import Request

# Connection lifecycle status surfaced to the owner (ADR-0097 §5). Written by the
# #1419 pull worker into ``config["status"]``; this module only reads it and
# defaults a freshly-connected row to ``connected``.
STATUS_CONNECTED = "connected"
STATUS_NOT_CONNECTED = "not_connected"
STATUS_AUTH_FAILED = "auth_failed"
# The credential is fine but its stored filter cannot be scoped safely, so the
# worker refuses to pull rather than pull wider than the owner asked for (#2888).
# A separate state from ``auth_failed`` because the remedy is the same wizard but
# the cause is not the token — telling the user their token expired would send
# them to re-issue a credential that was never the problem.
STATUS_INVALID_FILTER = "invalid_filter"

# ``config["last_sync"]["reason"]`` vocabulary (#2925), written by the pull worker
# (``tasks.py``) and validated on the way out by :func:`last_sync_summary`. A
# **fixed token set**, not a formatted message, and that is a security constraint
# rather than a style one: ``config`` is owner-readable over this module's ``GET``,
# and the exception text on those paths can carry the request URL (which embeds
# the owner's JQL, and on some deployments the credential) or provider-echoed PII.
# A closed vocabulary cannot leak either — the web maps the token to user-facing
# copy. Never interpolate an exception, URL, or response body into this field.
#
# Defined *here*, not beside the writer, so the read surface can fail closed
# against it without importing ``tasks`` (which imports this module). Writer
# discipline alone would leave the guarantee unenforced at the one boundary that
# serves it, and ``config`` is a schemaless column an Enterprise integration also
# writes to.
SYNC_REASON_AUTH_FAILED = "auth_failed"
SYNC_REASON_INVALID_FILTER = "invalid_filter"
SYNC_REASON_UNREACHABLE = "unreachable"
SYNC_REASON_RATE_LIMITED = "rate_limited"
SYNC_REASON_DECRYPT_FAILED = "credential_unreadable"
SYNC_FAILURE_REASONS: frozenset[str] = frozenset(
    {
        SYNC_REASON_AUTH_FAILED,
        SYNC_REASON_INVALID_FILTER,
        SYNC_REASON_UNREACHABLE,
        SYNC_REASON_RATE_LIMITED,
        SYNC_REASON_DECRYPT_FAILED,
    }
)

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
    "blocked_host": (
        "The host URL could not be reached — check it is correct, reachable over "
        "https, and not an internal address."
    ),
}


class ExternalConnectionUpsertSerializer(serializers.Serializer[Any]):
    """Payload for ``PUT /me/connections/{source}/`` (connect or update).

    ``secret`` is the user's own API token / PAT (write-only, never echoed).
    ``base_url`` is the source host — Jira Cloud ``https://<tenant>.atlassian.net``
    or a self-hosted Jira Data Center / Server host — allow-listed downstream.
    ``deployment`` (``cloud`` default | ``server``) selects the Cloud vs DC/Server
    API + auth shape. ``account_email`` (Cloud Basic auth only) + ``jql`` +
    ``project_keys`` are stored in the credential's ``config`` — the source reads
    them at pull time. ``jql`` selects what to pull; ``project_keys`` narrows it
    and is **ANDed onto** the query, whether that query is the default or a
    custom ``jql``, so the project filter can only ever restrict the pull.

    ``poll_enabled`` opts the connection into the background poll (ADR-0097 §4).
    It is declared **without** a ``default`` on purpose: a PUT rebuilds ``config``
    wholesale, so a defaulted field would silently switch polling off every time
    the owner re-connected to rotate a token. Absent from the payload therefore
    means "keep what this connection already had" — see
    :meth:`ExternalConnectionView.put`.
    """

    secret = serializers.CharField(
        write_only=True, min_length=1, max_length=4096, trim_whitespace=False
    )
    base_url = serializers.CharField(max_length=512)
    # Which Jira deployment this connection targets. Cloud is the default so a
    # payload from before the field existed (or any non-Jira source that ignores
    # it) keeps working unchanged.
    deployment = serializers.ChoiceField(
        choices=JIRA_DEPLOYMENTS, required=False, default=DEPLOYMENT_CLOUD
    )
    account_email = serializers.EmailField(required=False, allow_blank=True, default="")
    jql = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=1024,
        default="",
        help_text=(
            "Optional JQL selecting what to pull. Blank uses 'assigned to me and "
            "not done'. Parentheses and quotes must balance — the project filter "
            "is ANDed onto this query, which is only a narrowing on a "
            "well-formed one."
        ),
    )
    project_keys = serializers.ListField(
        child=serializers.CharField(max_length=64),
        required=False,
        default=list,
        max_length=50,
        help_text=(
            "Optional Jira project keys to restrict the pull to. Each must be a "
            "Jira project key (a letter followed by letters, digits or "
            "underscores); stored upper-cased and de-duplicated. Composed into "
            "the query as 'AND project IN (...)' on top of jql, so it can only "
            "narrow the pull. Empty means every project you can see."
        ),
    )
    poll_enabled = serializers.BooleanField(
        required=False,
        help_text=(
            "Opt this connection into the background poll (ADR-0097 §4). Omit to "
            "leave the current setting untouched — a re-connect must not silently "
            "switch polling off. Default off for a connection that never set it."
        ),
    )

    def validate_secret(self, value: str) -> str:
        if not value.strip():
            raise serializers.ValidationError("Secret must not be blank.")
        return value

    def validate_jql(self, value: str) -> str:
        """Reject a JQL whose parentheses or quotes do not balance.

        Not style policing. ``project_keys`` narrows the pull by wrapping this
        query in one pair of parentheses and ANDing a ``project IN (...)`` clause
        onto it, and an unbalanced query turns that wrap into a no-op that pulls
        from projects the owner did not select. Jira would reject a malformed query
        outright anyway, so the only thing this forbids is input that is already
        broken — and it surfaces as an inline message on the field instead of a
        connection that verifies, stores, and then fails on its first pull.
        """
        text = value.strip()
        if not text:
            return value
        try:
            scan_jql(text)
        except JqlNotWellFormed as exc:
            raise serializers.ValidationError(
                f"This filter is not valid JQL ({exc}). Check the parentheses and quotes."
            ) from exc
        return value

    def validate_project_keys(self, value: list[str]) -> list[str]:
        """Normalize + reject anything that is not a Jira project key (#2888).

        These keys are composed into the JQL the pull worker sends, so a value
        carrying a quote or a parenthesis could rewrite the filter it is meant to
        narrow. Rejecting at mint time gives the user an inline message on the
        connect wizard rather than a connection that fails on its first pull.
        Upper-cased and de-duplicated so the stored value matches what the wizard
        shows and what the query will carry.
        """
        cleaned: dict[str, None] = {}
        for raw in value:
            key = raw.strip()
            if not key:
                continue
            if not JIRA_PROJECT_KEY_RE.match(key):
                raise serializers.ValidationError(
                    f"{key!r} is not a valid project key. Use the short key Jira "
                    "shows on an issue (letters, digits and underscores, starting "
                    "with a letter) — for example RIV."
                )
            cleaned.setdefault(key.upper(), None)
        return list(cleaned)

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


class ExternalConnectionLastSyncSerializer(serializers.Serializer[Any]):
    """What the last pull actually did (#2925) — the outcome, not just the clock.

    Written by the pull worker into ``config["last_sync"]`` (``tasks.py``). Before
    this, a connection reported ``status`` + ``last_synced_at`` and nothing else,
    so "Connected, last synced 5 minutes ago" read identically whether the pull
    returned 200 items, zero, or failed — and a contributor past the source's page
    size got a silently partial My Work.

    ``truncated`` is the load-bearing field: it says the source had more than this
    pull stored, so the owner is looking at the first ``stored`` of their assigned
    work. ``total_available`` is the provider's own count when it reported one and
    ``null`` when it did not — ``null`` means *unknown*, never *zero*, and a client
    must not render a denominator from it.
    """

    at = serializers.DateTimeField(allow_null=True)
    ok = serializers.BooleanField()
    # A fixed token from ``tasks.SYNC_FAILURE_REASONS`` (blank on success), never a
    # formatted message — see that constant for why the vocabulary is closed.
    reason = serializers.CharField(allow_blank=True)
    fetched = serializers.IntegerField()
    stored = serializers.IntegerField()
    total_available = serializers.IntegerField(allow_null=True)
    truncated = serializers.BooleanField()


class ExternalConnectionSummarySerializer(serializers.Serializer[Any]):
    """Owner-facing summary of a connection — **never** the secret (ADR-0097 §3).

    The ``source`` key is intentionally not echoed: the caller already has it from
    the ``/me/connections/{source}/`` request path, and a serializer field literally
    named ``source`` collides with DRF's internal ``Field.source`` attribute.
    """

    name = serializers.CharField()
    exists = serializers.BooleanField()
    base_url = serializers.CharField(allow_blank=True)
    deployment = serializers.CharField()
    account_email = serializers.CharField(allow_blank=True)
    status = serializers.CharField()
    last_synced_at = serializers.DateTimeField(allow_null=True)
    jql = serializers.CharField(allow_blank=True)
    project_keys = serializers.ListField(child=serializers.CharField())
    # Whether the background poll picks this connection up (ADR-0097 §4). A
    # reviewed, owner-visible key — it is the owner's own setting, carries no
    # provider data, and the toggle that writes it has to be able to read its
    # current state back. Never inferred client-side from anything else.
    poll_enabled = serializers.BooleanField()
    # ``null`` until the connection's first pull completes — a freshly-connected
    # row has a status but no outcome yet, which is a different thing from a pull
    # that returned nothing.
    last_sync = ExternalConnectionLastSyncSerializer(allow_null=True)


class ExternalConnectionPollSerializer(serializers.Serializer[Any]):
    """Payload for ``PATCH /me/connections/{source}/`` — the poll opt-in, alone.

    A separate, one-field serializer rather than a partial
    :class:`ExternalConnectionUpsertSerializer`: flipping the background-poll
    switch must not require the owner to re-enter their API token (``secret`` is
    required on the upsert and is never readable back), and a partial upsert would
    also make every other connection field silently writable from a control whose
    entire job is one boolean. Anything else in the body is ignored, so this
    endpoint can never rewrite a credential, host, or filter.
    """

    poll_enabled = serializers.BooleanField()


class ExternalConnectionErrorSerializer(serializers.Serializer[Any]):
    """422 body when credential verification against the source fails."""

    detail = serializers.CharField()
    code = serializers.CharField()
    reason = serializers.CharField(allow_null=True)


def last_sync_summary(config: dict[str, Any] | None) -> dict[str, Any] | None:
    """Project ``config["last_sync"]`` onto the owner-facing outcome shape (#2925).

    Field-by-field with per-field type coercion rather than passing the stored
    dict through. ``config`` is a schemaless ``JSONField`` that also holds the
    connection's filter and (for other providers on the same model) whatever an
    Enterprise integration put there — echoing it wholesale would turn any future
    key into an unreviewed client-visible field, which is exactly the
    over-exposure the summary's "never the secret" contract exists to prevent.
    Anything absent or of the wrong type degrades to the neutral value, so a
    hand-edited or pre-#2925 row renders as "no outcome recorded" instead of
    raising.

    Returns ``None`` when no pull has ever completed — distinct from a pull that
    completed and stored nothing.
    """
    raw = (config or {}).get("last_sync")
    if not isinstance(raw, dict):
        return None
    total = raw.get("total_available")
    at = raw.get("at")
    # Fail closed on ``reason``: only a token from the closed vocabulary leaves
    # this boundary. Type-checking it would enforce nothing — the whole point of
    # the vocabulary is that a *formatted* string must never reach a client, and
    # a formatted string is a ``str``. Anything unrecognized degrades to blank,
    # which the web already renders as its generic "didn't complete" sentence.
    raw_reason = raw.get("reason")
    reason = raw_reason if raw_reason in SYNC_FAILURE_REASONS else ""
    # ``None`` is meaningful for the total ("the source did not say"), so it is
    # not collapsed to 0 the way the two counts are.
    total_ok = isinstance(total, int) and not isinstance(total, bool)
    return {
        "at": at if isinstance(at, str) else None,
        "ok": bool(raw.get("ok")),
        "reason": reason,
        "fetched": _as_count(raw.get("fetched")),
        "stored": _as_count(raw.get("stored")),
        "total_available": total if total_ok else None,
        "truncated": bool(raw.get("truncated")),
    }


def _as_count(value: Any) -> int:
    """Narrow an untrusted stored value to a non-negative count (0 if it is not one).

    ``bool`` is excluded explicitly because it is an ``int`` subclass, so ``True``
    would otherwise read back as a count of 1.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(int(value), 0)


def _summary(label: str, row: IntegrationCredential | None) -> dict[str, Any]:
    """Build the owner-facing summary dict for one source (secret excluded)."""
    cfg = (row.config if row else None) or {}
    return {
        "name": label,
        "exists": row is not None,
        "base_url": row.base_url if row else "",
        # Cloud is the default for a row stored before the discriminant existed.
        "deployment": cfg.get("deployment", DEPLOYMENT_CLOUD),
        "account_email": cfg.get("account_email", ""),
        # Freshly-connected rows read ``connected``; the #1419 worker flips this to
        # ``auth_failed`` on a 401/403 so My Work can show a "Reconnect" prompt.
        "status": cfg.get("status") or (STATUS_CONNECTED if row else STATUS_NOT_CONNECTED),
        # ``last_used_at`` is stamped by the pull worker when it last used the token.
        "last_synced_at": row.last_used_at if row else None,
        "jql": cfg.get("jql", ""),
        "project_keys": cfg.get("project_keys", []),
        # ``is True``, not ``bool()``: ``config`` is a schemaless column, and the
        # poll selects on ``config__poll_enabled=True`` — strict JSON equality. A
        # row carrying the string ``"false"`` is truthy in Python and *not* what
        # the poll matches, so a ``bool()`` coercion would render the switch on for
        # a connection that is never polled. Report what the poll acts on.
        "poll_enabled": cfg.get("poll_enabled") is True,
        # What the last pull did — counts, and whether a cap truncated it (#2925).
        "last_sync": last_sync_summary(cfg),
    }


@extend_schema(tags=["me"])
class ExternalConnectionView(IdempotencyMixin, APIView):
    """Manage the authenticated user's connection to one external task source.

    Routes (``<source>`` is an ``EXTERNAL_TASK_SOURCES`` key, e.g. ``jira``):
        GET    /api/v1/me/connections/{source}/   summary (exists / status / config)
        PUT    /api/v1/me/connections/{source}/   connect or update (verify then store)
        PATCH  /api/v1/me/connections/{source}/   flip the background-poll opt-in
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
            # Two different 400 bodies reach a caller here, so this is declared as
            # a description rather than a serializer: an unknown source key or a
            # disallowed ``base_url`` returns ``{detail, code}``, while DRF field
            # validation (``secret``, ``base_url``, ``jql``, ``project_keys``)
            # returns its own field-keyed ``{field: [message]}`` shape. Declaring
            # either serializer would document one and misdescribe the other.
            400: OpenApiResponse(
                description=(
                    "Unknown source, disallowed host URL, or a field that failed "
                    "validation (an unparseable JQL filter, or a project key that "
                    "is not a Jira project key)."
                )
            ),
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
            # False positive: BaseUrlNotAllowed carries a curated, user-facing
            # message (#902); the only dynamic part is the caller's own submitted
            # host, and it is an allow-list decision, not a DNS-resolved address.
            return Response(
                {
                    "detail": str(exc),  # codeql[py/stack-trace-exposure]
                    "code": "base_url_not_allowed",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Rebuilt from the payload, so a re-connect deliberately drops any stored
        # ``last_sync``: the outcome described a pull made with the *previous*
        # token and filter, and carrying it onto a connection whose filter just
        # changed would report a truncation (or a count) that no longer applies.
        existing = self._row(request, source)
        # ``poll_enabled`` is the one key a rebuild must *not* drop. The rest of
        # ``config`` describes the credential and its filter, both of which this
        # payload replaces; the poll opt-in is an independent standing preference
        # the owner set elsewhere (the Connected Accounts toggle → PATCH below).
        # Rotating a token would otherwise silently stop a connection polling,
        # with nothing in the UI to say it had happened.
        existing_cfg = (existing.config if existing else None) or {}
        current_poll = bool(existing_cfg.get("poll_enabled", False))
        config: dict[str, Any] = {
            "deployment": data.get("deployment", DEPLOYMENT_CLOUD),
            "account_email": data.get("account_email", ""),
            "jql": data.get("jql", ""),
            "project_keys": data.get("project_keys", []),
            "poll_enabled": bool(data.get("poll_enabled", current_poll)),
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

    @extend_schema(
        # A raw schema, not ``ExternalConnectionPollSerializer``: drf-spectacular
        # rewrites any serializer on a PATCH into a ``Patched…`` component with
        # every field optional, which would document ``poll_enabled`` as omittable
        # when the handler answers 400 without it. The serializer still does the
        # validating — this only stops the schema from describing a shape the
        # endpoint rejects. (``COMPONENT_SPLIT_PATCH`` is the global lever and is
        # deliberately left alone; this is one endpoint, not a project-wide policy.)
        request={
            "application/json": {
                "type": "object",
                "properties": {
                    "poll_enabled": {
                        "type": "boolean",
                        "description": (
                            "Whether the background poll (ADR-0097 §4) should pick this "
                            "connection up. Required — there is no partial form of this "
                            "request."
                        ),
                    }
                },
                "required": ["poll_enabled"],
            }
        },
        responses={
            200: ExternalConnectionSummarySerializer,
            400: OpenApiResponse(
                description="Unknown source, or poll_enabled missing / not a boolean."
            ),
            404: OpenApiResponse(description="No connection to this source for this user."),
        },
    )
    def patch(self, request: Request, source: str) -> Response:
        """Turn the background poll on or off for this connection (ADR-0097 §4).

        The only mutation on a *stored* connection that does not go through the
        connect wizard, because it is the only one that needs no credential. The
        IDOR boundary is the same single ``(user, provider)`` filter every other
        action uses (``self._row``): a source another user connected simply does
        not exist for this caller, so a 404 is a "you have no such connection",
        never a leak that someone else does.

        ``config`` is copied-then-reassigned rather than mutated in place — the
        JSONField's value is a live dict, and mutating it leaves Django unable to
        tell the field changed if anything later relies on the loaded state.
        """
        source_cls = self._resolve_source(source)
        if source_cls is None:
            return Response(
                {"detail": f"Unknown external task source {source!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = ExternalConnectionPollSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        row = self._row(request, source)
        if row is None:
            return Response(
                {"detail": f"No {source} connection to configure — connect it first."},
                status=status.HTTP_404_NOT_FOUND,
            )
        config = dict(row.config or {})
        config["poll_enabled"] = bool(serializer.validated_data["poll_enabled"])
        row.config = config
        # ``updated_at`` is ``auto_now``; naming it keeps the stamp truthful, which
        # an ``update_fields`` list omitting it would silently skip.
        row.save(update_fields=["config", "updated_at"])
        payload = _summary(getattr(source_cls, "label", source), row)
        return Response(ExternalConnectionSummarySerializer(payload).data)

    @extend_schema(
        responses={
            204: None,
            400: state_refusal_400(
                "``source`` does not name a registered external task source. The "
                "path segment is free text, so an unregistered value reaches the "
                "handler and is refused here rather than 404ing (#3319)."
            ),
        }
    )
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
        user = self._user(request)
        IntegrationCredential.objects.filter(user=user, provider=source).delete()
        ExternalWorkItem.objects.filter(user=user, source=source).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ExternalSyncQueuedSerializer(serializers.Serializer[Any]):
    """202 body for a queued pull — ``{"queued": true}`` (not a task id)."""

    queued = serializers.BooleanField()


class ExternalSyncCooldownSerializer(serializers.Serializer[Any]):
    """429 body when a manual refresh lands inside the per-connection cooldown."""

    detail = serializers.CharField()
    code = serializers.CharField()
    retry_after = serializers.IntegerField()


@extend_schema(tags=["me"])
class ExternalConnectionSyncView(IdempotencyMixin, APIView):
    """Trigger a read-only pull of one external-source connection (ADR-0097 §4).

    ``POST /api/v1/me/connections/{source}/sync/`` → ``202 {"queued": true}``.
    Self-scoped: only the owner can trigger their own pull. The pull runs through
    the ``ExternalSyncRequest`` outbox (never a direct ``.delay()``), so a broker
    outage degrades to the drain rather than dropping the request.
    """

    permission_classes: list[type[BasePermission]] = [IsAuthenticated]  # noqa: RUF012
    throttle_classes: list[type[BaseThrottle]] = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "external_sync"

    @extend_schema(
        request=None,
        responses={
            202: ExternalSyncQueuedSerializer,
            400: state_refusal_400(
                "``source`` does not name a registered external task source. The "
                "path segment is free text, so an unregistered value reaches the "
                "handler and is refused here rather than 404ing (#3319)."
            ),
            429: ExternalSyncCooldownSerializer,
        },
    )
    def post(self, request: Request, source: str) -> Response:
        if EXTERNAL_TASK_SOURCES.get(source) is None:
            return Response(
                {"detail": f"Unknown external task source {source!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user = cast("User", request.user)
        # A pull needs a stored connection to read the token + config from.
        if not IntegrationCredential.objects.filter(user=user, provider=source).exists():
            return Response(
                {"detail": f"No {source} connection to sync — connect it first."},
                status=status.HTTP_404_NOT_FOUND,
            )
        try:
            enqueue_external_sync(user.pk, source)
        except SyncCooldownActive as exc:
            resp = Response(
                {
                    "detail": (
                        "This connection was refreshed a moment ago — "
                        f"try again in {exc.retry_after}s."
                    ),
                    "code": "sync_cooldown",
                    "retry_after": exc.retry_after,
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
            # Standard header so a client can honor the cooldown without parsing
            # the body (RFC 9110 §10.2.3).
            resp["Retry-After"] = str(exc.retry_after)
            return resp
        return Response({"queued": True}, status=status.HTTP_202_ACCEPTED)


class ExternalWorkItemSerializer(serializers.Serializer[Any]):
    """One read-only external work item row for My Work (ADR-0097 §4).

    Deliberately CPM-free: an external item is a personal cache row, never a
    ``Task``, so it carries no schedule/board fields — only what My Work needs to
    render a labeled, read-only link that opens in the provider.
    """

    id = serializers.UUIDField(read_only=True)
    # ``source_key`` (not ``source``): a serializer field literally named
    # ``source`` collides with DRF's internal ``Field.source`` attribute (same
    # reason the connection summary omits it). ``source="source"`` maps this
    # differently-named field back onto the model's ``source`` column.
    source_key = serializers.CharField(source="source", read_only=True)
    external_id = serializers.CharField(read_only=True)
    external_url = serializers.CharField(read_only=True, allow_blank=True)
    title = serializers.CharField(read_only=True, allow_blank=True)
    external_status = serializers.CharField(read_only=True, allow_blank=True)
    display_bucket = serializers.CharField(read_only=True)
    last_synced_at = serializers.DateTimeField(read_only=True, allow_null=True)


class ExternalWorkItemPagination(pagination.LimitOffsetPagination):
    """Limit/offset pagination for the personal external-items list."""

    default_limit = 100
    max_limit = 200


@extend_schema(tags=["me"])
class ExternalWorkItemListView(generics.ListAPIView[ExternalWorkItem]):
    """List the authenticated user's cached external work items (ADR-0097 §3).

    ``GET /api/v1/me/external-items/`` — the read-only items pulled from the
    user's connected sources, for the My Work external section. Strictly personal:
    the queryset filters ``user=request.user`` and hides soft-removed
    (``is_stale``) rows, so no other user (member, Admin, or Owner) can ever see
    another user's external items. Ordering comes from the model ``Meta``
    (``display_bucket``, ``external_id``) so items group by bucket in My Work.
    """

    permission_classes: list[type[BasePermission]] = [IsAuthenticated]  # noqa: RUF012
    serializer_class = ExternalWorkItemSerializer
    pagination_class = ExternalWorkItemPagination

    def get_queryset(self) -> Any:
        user = cast("User", self.request.user)
        return ExternalWorkItem.objects.filter(user=user, is_stale=False)
