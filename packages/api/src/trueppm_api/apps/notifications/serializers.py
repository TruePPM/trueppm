"""DRF serializers for the notifications app (ADR-0075)."""

from __future__ import annotations

import logging
import re
import zoneinfo
from functools import partial
from typing import Any, cast

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from trueppm_api.apps.projects.schema_migrations import migrate_payload

from .categories import category_for
from .delivery_limits import EMAIL_MAX_BATCH_SIZE
from .models import (
    EmailSecurity,
    EmailTransportMode,
    Mention,
    Notification,
    NotificationPreference,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
    UserNotificationSettings,
    WorkspaceEmailSettings,
)
from .schema_migrations import SURFACE_PROJECT_NOTIFICATION_MATRIX

logger = logging.getLogger(__name__)

# DKIM selector: a single DNS label component set (letters, digits, dot, dash,
# underscore), capped to the model's 63-char column. Restricting this prevents
# DNS-name injection into the deliverability health lookup (security review M3).
_DKIM_SELECTOR_RE = re.compile(r"^[A-Za-z0-9._-]{1,63}$")

# Transports that require a stored/submitted credential.
_CREDENTIAL_MODES = {
    EmailTransportMode.SMTP,
    EmailTransportMode.SENDGRID,
    EmailTransportMode.SES,
}
# Transports where the admin supplies the relay host (SendGrid's host is fixed).
_HOST_REQUIRED_MODES = {EmailTransportMode.SMTP, EmailTransportMode.SES}
# Transports where the admin supplies the SMTP AUTH username. SendGrid is excluded
# because its username is server-fixed to the literal "apikey" (the key travels as
# the password), and CLOUD stores no credentials at all.
_USERNAME_REQUIRED_MODES = {EmailTransportMode.SMTP, EmailTransportMode.SES}


def _effective(attrs: dict[str, Any], instance: Any, field: str, default: Any = "") -> Any:
    """Value ``field`` will hold after this write.

    A PATCH only carries the fields being changed, so validation has to reason
    about the *merged* record: incoming value if the request set one, otherwise
    whatever is already stored.
    """
    if field in attrs:
        return attrs[field]
    return getattr(instance, field, default)


def _assert_transport_fields(
    *,
    mode: Any,
    host: str,
    username: str,
    effective_pw: str,
    needs_fresh_password: bool,
) -> None:
    """Reject a transport config that is missing something the transport needs.

    Runs before the live probe so a config that cannot possibly work is refused
    without opening a connection.
    """
    # Reusing a stale secret across a transport switch is a footgun — a
    # SendGrid API key is not an SES password (security review M2).
    if needs_fresh_password and mode in _CREDENTIAL_MODES:
        raise serializers.ValidationError(
            {"password": "Re-enter the password when changing the transport."}
        )

    if mode in _HOST_REQUIRED_MODES and not host:
        raise serializers.ValidationError({"host": "Host is required for this transport."})

    # SMTP AUTH is a (username, password) pair, so a blank username is not a
    # weaker credential — it is *no* credential. Django's SMTP backend calls
    # login() only when both are truthy, so a blank username makes the probe
    # open an unauthenticated connection that succeeds, persisting a config
    # whose every real send then fails 530 Authentication Required. Requiring
    # it here is what makes the validate-before-persist gate honest.
    if mode in _USERNAME_REQUIRED_MODES and not username:
        raise serializers.ValidationError(
            {
                "username": (
                    "A username is required for this transport — the mail server "
                    "authenticates as this account. It is usually the full email "
                    "address that owns the password or app password."
                )
            }
        )

    if not effective_pw:
        raise serializers.ValidationError(
            {"password": "A password is required for this transport."}
        )


def _probe_or_raise(
    *,
    mode: Any,
    host: str,
    port: Any,
    security: Any,
    username: str,
    password: str,
) -> None:
    """Validate-before-persist: open the candidate transport now.

    Generic error only — never leak the underlying smtplib exception (M1).
    """
    from .email_backend import EmailTransportError, probe_transport

    try:
        probe_transport(
            transport_mode=str(mode),
            host=host,
            port=int(port),
            security=str(security),
            username=username,
            password=password,
        )
    except EmailTransportError as exc:
        # Curated message only — never surface the exception object. The
        # SSRF-guarded host path can carry the DNS-resolved internal address
        # (scrubbed from the client at email_backend._assert_host_public);
        # log the detail server-side (CodeQL py/stack-trace-exposure).
        logger.info("email transport probe failed (host=%s port=%s): %s", host, port, exc)
        raise serializers.ValidationError(
            {
                "non_field_errors": [
                    "Could not connect to the mail server with these settings. "
                    "Check the host, port, security, and credentials."
                ]
            }
        ) from exc


class MentionAuthorSerializer(serializers.Serializer[Any]):
    """Nested read-only user summary for Mention.mentioner / mentioned_user."""

    id = serializers.UUIDField(read_only=True)
    username = serializers.CharField(read_only=True)
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        name: str = obj.get_full_name() or obj.username
        return name


class MentionSerializer(serializers.ModelSerializer[Mention]):
    """Read-only serializer for Mention.

    Mentions are append-only — no write path through this serializer. Created
    indirectly via TaskCommentSerializer.create + services.create_mention_notifications.
    """

    mentioner = MentionAuthorSerializer(read_only=True)
    mentioned_user = MentionAuthorSerializer(read_only=True)

    class Meta:
        model = Mention
        fields = [
            "id",
            "mentioner",
            "mentioned_user",
            "mentioned_group_key",
            "scope",
            "task_comment",
            "created_at",
        ]
        read_only_fields = fields


class NotificationSerializer(serializers.ModelSerializer[Notification]):
    """Per-recipient inbox row.

    Writes are limited to is_read / is_archived (PATCH-only on the viewset).
    All other fields are read-only.
    """

    mention = MentionSerializer(read_only=True)
    snippet = serializers.SerializerMethodField()
    task_id = serializers.SerializerMethodField()
    # Derived read-only category (ADR-0216 §3) — mentions | tasks | signals |
    # project. Sourced from categories.category_for so the field and the
    # ?category= filter share one mapping and never drift.
    category = serializers.SerializerMethodField()

    def get_category(self, obj: Notification) -> str:
        return category_for(obj)

    def get_snippet(self, obj: Notification) -> str:
        """Short preview of the source mention's body.

        Truncated to 200 chars. Returns empty string if the source is
        unavailable (e.g. comment soft-deleted).

        Cross-project gate (#514): the snippet is a project member's-eyes view
        of the source comment body, so it is returned ONLY to a recipient who
        is a *current* member of the mention's source project. Program-scoped
        auto-groups (`@program-*`) fan a mention out to members of sibling
        projects who are NOT members of the source project — for them the row
        still surfaces (they know they were pinged) but the body is redacted, so
        a program ping never leaks one project's comment content to another
        project's team. This also honors the standing rule that a departed
        member no longer sees the body. Project membership is the read boundary
        in OSS; the program is a coordination unit, not a shared-content unit.
        """
        mention = obj.mention
        if mention is None:
            return ""
        comment = mention.task_comment
        if comment is None or comment.is_deleted:
            return ""
        if not self._recipient_can_see_source(obj, mention):
            return ""
        body = comment.body or ""
        return body[:200]

    def _recipient_can_see_source(self, obj: Notification, mention: Mention) -> bool:
        """True if the notification's recipient currently belongs to the source
        project of ``mention`` (so the body snippet is safe to reveal).

        The set of the recipient's member projects is resolved once per response
        and memoized on the serializer context, so the inbox list stays O(1)
        queries rather than one membership query per row. Falls open only when
        there is no request/user context at all (e.g. a bare unit test
        serializing without a request) — every real read path (the viewset)
        supplies it.
        """
        source_project_id = mention.project_id
        if source_project_id is None:
            return True
        member_project_ids = self.context.get("member_project_ids")
        if member_project_ids is None:
            request = self.context.get("request")
            user = getattr(request, "user", None) if request is not None else None
            if user is None or not getattr(user, "is_authenticated", False):
                return True  # no user context to gate against — preserve behavior
            from trueppm_api.apps.access.models import ProjectMembership

            member_project_ids = set(
                ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
                    "project_id", flat=True
                )
            )
            # DRF's serializer context is a plain dict at runtime (typed Mapping
            # in the stubs); memoize so the list path resolves membership once.
            cast(dict[str, Any], self.context)["member_project_ids"] = member_project_ids
        return source_project_id in member_project_ids

    def get_task_id(self, obj: Notification) -> str | None:
        # Event-sourced rows (#497/#861) carry a direct deep-link FK; mention
        # rows resolve their task through the source comment. Prefer the explicit
        # FK so the inbox row links to the affected task/milestone either way.
        if obj.task_id is not None:
            return str(obj.task_id)
        mention = obj.mention
        if mention is None or mention.task_comment is None:
            return None
        return str(mention.task_comment.task_id)

    class Meta:
        model = Notification
        # event_type/subject/body are the event-sourced inbox payload (#639,
        # #497, #861). They were inbox-invisible before — a mention row leaves
        # them blank and renders from `snippet`; an event row has no mention, so
        # without these fields the client could not show its title/preview and
        # fell back to "mentioned you / comment unavailable".
        fields = [
            "id",
            "recipient",
            "mention",
            "event_type",
            "subject",
            "body",
            "project",
            "is_read",
            "is_archived",
            "snoozed_until",
            "category",
            "created_at",
            "read_at",
            "snippet",
            "task_id",
        ]
        read_only_fields = [
            "id",
            "recipient",
            "mention",
            "event_type",
            "subject",
            "body",
            "project",
            # snoozed_until is written by the dedicated snooze action, never PATCH.
            "snoozed_until",
            "category",
            "created_at",
            "read_at",
            "snippet",
            "task_id",
        ]


class NotificationPreferenceSerializer(serializers.ModelSerializer[NotificationPreference]):
    """Per-user (event_type, channel) toggle.

    PATCH on the viewset only modifies `enabled` — event_type / channel /
    user are immutable.
    """

    class Meta:
        model = NotificationPreference
        fields = ["id", "event_type", "channel", "enabled", "updated_at"]
        read_only_fields = ["id", "event_type", "channel", "updated_at"]


# ---------------------------------------------------------------------------
# Project-scoped preferences (#522)
# ---------------------------------------------------------------------------


_VALID_EVENT_TYPES = {choice.value for choice in ProjectNotificationEventType}
_VALID_CHANNELS = {choice.value for choice in ProjectNotificationChannel}


#: The published shape of the notification matrix (#3364).
#:
#: A bare ``JSONField`` carries no schema hint, so drf-spectacular publishes it as
#: ``{}`` — "any JSON at all". That is not a small imprecision on this field: it is
#: the only thing ``PATCH .../notification-preferences/`` exists to write, and the
#: field below rejects every key outside the two enumerations with a 400. Declaring
#: the body while leaving its one field untyped would tell an integrator "send some
#: JSON" and 400 on every guess — the same gap #3364 closes one level up.
#:
#: Derived from the enums rather than restated, so a new event type or channel
#: reaches the published contract without a second edit that can be forgotten.
#:
#: ``propertyNames`` is JSON Schema, not OpenAPI 3.0 Schema Object — this project
#: publishes ``openapi: 3.0.3`` (see ``docs/api/openapi.json``), whose meta-schema
#: has no such keyword and rejects the whole object under ``additionalProperties``'
#: ``oneOf`` the moment it appears anywhere in the tree. The two enumerations are
#: small and closed, so each key is spelled out explicitly under ``properties``
#: instead, with ``additionalProperties: False`` doing the same "no unknown key"
#: rejection ``propertyNames`` would have — this is what "9×4 grid" means literally.
_PROJECT_NOTIFICATION_MATRIX_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "Per-event, per-channel routing grid. Keys are event types; each value is "
        "an object of channel to boolean. A PATCH may send a partial grid — the "
        "supplied cells are merged onto the stored ones, so a single toggle need "
        "not repost the whole matrix. Any key outside these two enumerations, or "
        "any non-boolean leaf, is rejected with a 400."
    ),
    "properties": {
        event_type: {
            "type": "object",
            "properties": {channel: {"type": "boolean"} for channel in sorted(_VALID_CHANNELS)},
            "additionalProperties": False,
        }
        for event_type in sorted(_VALID_EVENT_TYPES)
    },
    "additionalProperties": False,
}


@extend_schema_field(_PROJECT_NOTIFICATION_MATRIX_SCHEMA)
class _ProjectNotificationMatrixField(serializers.JSONField):
    """JSON matrix `{event_type: {channel: bool}}` with strict key validation.

    Rejects unknown event types and channels at the serializer layer so a
    typo in the client doesn't silently corrupt the stored matrix. Non-bool
    leaves are also rejected — there is no "tri-state" toggle.
    """

    def to_internal_value(self, data: Any) -> dict[str, dict[str, bool]]:
        value = super().to_internal_value(data)
        if not isinstance(value, dict):
            raise serializers.ValidationError("matrix must be a JSON object")
        validated: dict[str, dict[str, bool]] = {}
        for event_type, channels in value.items():
            if event_type not in _VALID_EVENT_TYPES:
                raise serializers.ValidationError(f"Unknown event_type: {event_type!r}")
            if not isinstance(channels, dict):
                raise serializers.ValidationError(
                    f"matrix[{event_type!r}] must be an object of channel→bool"
                )
            row: dict[str, bool] = {}
            for channel, enabled in channels.items():
                if channel not in _VALID_CHANNELS:
                    raise serializers.ValidationError(f"Unknown channel: {channel!r}")
                if not isinstance(enabled, bool):
                    raise serializers.ValidationError(
                        f"matrix[{event_type!r}][{channel!r}] must be a boolean"
                    )
                row[channel] = enabled
            validated[event_type] = row
        return validated


class ProjectNotificationPreferenceSerializer(
    serializers.ModelSerializer[ProjectNotificationPreference]
):
    """Per-(project, user) notification preferences.

    The full matrix and quiet-hours window are returned in one document; the
    PATCH path merges the supplied matrix onto the stored one so a partial
    toggle does not have to repost the full 9×4 grid.

    On read, matrix is run through the forward-migration registry
    (``schema_migrations.migrate_payload``, ADR-0086 / ADR-0204, #1916): a
    stale stored payload is upgraded to the current shape before any client
    sees it, mirroring ``BoardSavedViewSerializer``. The view layer's
    ``_merge_matrix`` overlay still runs afterward (it also drops unknown
    garbage keys, #675 — a distinct concern from the version upgrade), so this
    is defense-in-depth for any caller that reads this serializer directly
    rather than through ``ProjectNotificationPreferenceView``.
    """

    matrix = _ProjectNotificationMatrixField()

    class Meta:
        model = ProjectNotificationPreference
        fields = [
            "matrix",
            "schema_version",
            "paused",
            "quiet_hours_enabled",
            "quiet_hours_from",
            "quiet_hours_until",
            "updated_at",
        ]
        read_only_fields = ["schema_version", "updated_at"]

    def to_representation(self, instance: ProjectNotificationPreference) -> dict[str, Any]:
        """Upgrade the stored matrix to the current shape on read.

        The stored payload's version is the model's ``schema_version`` column
        (rows predating the convention carry the migration default of 1 and
        are already at the current 9-event shape, so the chain is a no-op for
        them). Passing it explicitly keeps the column as the single source of
        truth for "which shape is this" rather than sniffing the payload.
        """
        data = super().to_representation(instance)
        matrix = data.get("matrix")
        if isinstance(matrix, dict):
            upgraded, version = migrate_payload(
                SURFACE_PROJECT_NOTIFICATION_MATRIX,
                matrix,
                from_version=instance.schema_version,
            )
            # schema_version is exposed as a sibling metadata field, not mixed
            # into the matrix event/channel grid — keep matrix the clean grid.
            upgraded.pop("schema_version", None)
            data["matrix"] = upgraded
            data["schema_version"] = version
        return data


class UserNotificationSettingsSerializer(serializers.ModelSerializer[UserNotificationSettings]):
    """Account-wide notification settings (#1707, ADR-0292; digest slot ADR-0663).

    ``dnd_enabled`` plus the weekly digest slot (``digest_weekday`` /
    ``digest_hour`` / ``digest_timezone``) are writable; ``updated_at`` is
    read-only. The endpoint is self-scoped (the row is always the caller's own), so
    there is no ``user`` field to expose or spoof.

    The slot fields are range- and tz-validated rather than clamped: a bad value
    must surface as a 400 the user can act on. Silently coercing hour 25 to 23
    would leave someone waiting for a digest that arrives at the wrong time with no
    indication anything was wrong.
    """

    class Meta:
        model = UserNotificationSettings
        fields = [
            "dnd_enabled",
            "digest_weekday",
            "digest_hour",
            "digest_timezone",
            "updated_at",
        ]
        read_only_fields = ["updated_at"]

    def validate_digest_weekday(self, value: int) -> int:
        """0=Monday .. 6=Sunday, matching Python's ``date.weekday()``."""
        if not 0 <= value <= 6:
            raise serializers.ValidationError("Must be between 0 (Monday) and 6 (Sunday).")
        return value

    def validate_digest_hour(self, value: int) -> int:
        """Local hour of day, 0-23."""
        if not 0 <= value <= 23:
            raise serializers.ValidationError("Must be between 0 and 23.")
        return value

    def validate_digest_timezone(self, value: str) -> str:
        """An IANA key, or blank to use the server timezone.

        Validated against the running interpreter's tz database so a typo is a 400
        at save time rather than a digest that silently never fires.
        """
        if value and value not in zoneinfo.available_timezones():
            raise serializers.ValidationError(f"Unknown timezone: {value!r}")
        return value


class WorkspaceEmailSettingsSerializer(serializers.ModelSerializer[WorkspaceEmailSettings]):
    """Read/write serializer for the workspace SMTP singleton (#712, ADR-0213).

    The password is **write-only** and never echoed — the response carries only
    ``password_is_set``. On update, an omitted/blank ``password`` keeps the
    stored secret (rotate-vs-keep); a non-empty value replaces it. The
    validate-before-persist probe opens the candidate transport before ``save``
    so a bad configuration cannot lock the workspace out of mail. All admin-
    supplied network/header inputs are validated against SSRF and header
    injection (security review H1/M2/M3).
    """

    # Write-only credential. required=False so other fields can be edited
    # without re-submitting it; allow_blank so "" explicitly means "keep".
    password = serializers.CharField(
        write_only=True,
        required=False,
        allow_blank=True,
        max_length=4096,
        trim_whitespace=False,
        style={"input_type": "password"},
    )
    password_is_set = serializers.BooleanField(read_only=True)

    # Rows one drain tick may claim (#2860 rebound this from "addresses per message",
    # which nothing implemented). The drain caps every tick at EMAIL_MAX_BATCH_SIZE
    # regardless, because a tick runs under a 25 s soft time limit — so a larger value
    # was accepted, persisted, echoed back and then silently discarded (#2887 item 2).
    # Rejecting it out loud is the whole point: a control that reports a value it does
    # not apply is the dead-control failure mode wearing a different hat. ``0`` means
    # "no explicit cap" and falls back to EMAIL_MAX_BATCH_SIZE, which is why min_value
    # is 0 rather than 1.
    max_recipients = serializers.IntegerField(
        required=False,
        min_value=0,
        max_value=EMAIL_MAX_BATCH_SIZE,
        help_text=(
            f"Queued emails one drain tick sends, 1-{EMAIL_MAX_BATCH_SIZE}. "
            f"0 means no explicit cap ({EMAIL_MAX_BATCH_SIZE} per tick)."
        ),
    )

    class Meta:
        model = WorkspaceEmailSettings
        fields = [
            "transport_mode",
            "host",
            "port",
            "security",
            "username",
            "password",
            "password_is_set",
            "from_name",
            "from_email",
            "reply_to",
            "dkim_selector",
            "max_recipients",
            "throttle_per_min",
            "updated_at",
        ]
        read_only_fields = ["updated_at"]

    # -- field-level validation ------------------------------------------------

    def validate_port(self, value: int) -> int:
        if not (1 <= value <= 65535):
            raise serializers.ValidationError("Port must be between 1 and 65535.")
        return value

    def validate_from_name(self, value: str) -> str:
        # Header-injection guard: a CRLF in the From display name could inject
        # extra headers. Django's sanitizer catches raw CRLF, but reject here
        # for a clear message (security review M3).
        if "\r" in value or "\n" in value:
            raise serializers.ValidationError("From name must not contain line breaks.")
        return value

    def validate_dkim_selector(self, value: str) -> str:
        if value and not _DKIM_SELECTOR_RE.match(value):
            raise serializers.ValidationError(
                "DKIM selector may contain only letters, digits, '.', '_', and '-'."
            )
        return value

    # -- object-level validation + persist ------------------------------------

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        instance = self.instance
        # Bound rather than nested: a closure's own branching is charged to its
        # enclosing function, and a module-level resolver is testable alone.
        eff = partial(_effective, attrs, instance)

        mode = eff("transport_mode", EmailTransportMode.CLOUD)
        if mode == EmailTransportMode.CLOUD:
            # Nothing to probe — fall back to the global backend at send time.
            return attrs

        host = (eff("host") or "").strip()
        port = eff("port", 587)
        security = eff("security", EmailSecurity.TLS)
        username = (eff("username") or "").strip()

        incoming_pw = attrs.get("password", "")
        stored_pw = instance.get_password() if instance is not None else ""
        mode_changed = instance is not None and instance.transport_mode != mode

        effective_pw = incoming_pw or stored_pw
        _assert_transport_fields(
            mode=mode,
            host=host,
            username=username,
            effective_pw=effective_pw,
            needs_fresh_password=mode_changed and not incoming_pw,
        )
        _probe_or_raise(
            mode=mode,
            host=host,
            port=port,
            security=security,
            username=username,
            password=effective_pw,
        )

        return attrs

    def update(
        self, instance: WorkspaceEmailSettings, validated_data: dict[str, Any]
    ) -> WorkspaceEmailSettings:
        password = validated_data.pop("password", None)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        # Rotate only when a non-empty password was submitted; blank keeps the
        # stored ciphertext untouched (never overwrite with b"").
        if password:
            # This is a third-party SMTP relay credential (Fernet-encrypted at
            # rest), not a Django auth password — validate_password() enforces
            # user-account policy (min length, common-password blocklist) that is
            # meaningless for a provider-issued secret the operator cannot change.
            # nosemgrep: unvalidated-password
            instance.set_password(password)
        request = self.context.get("request")
        if request is not None and getattr(request, "user", None) is not None:
            instance.updated_by = request.user
        instance.save()
        return instance
