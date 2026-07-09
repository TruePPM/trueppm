"""ViewSets for the per-user notification inbox + preferences (ADR-0075)."""

from __future__ import annotations

import datetime
import logging
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsOrgAdmin,
    IsProjectMember,
    IsWorkspaceOperator,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Project

from .categories import CATEGORIES, CATEGORY_MENTIONS, event_types_for_category
from .models import (
    DEFAULT_PREFERENCES,
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    SIGNAL_ONLY_EVENTS,
    EmailTransportMode,
    Notification,
    NotificationChannel,
    NotificationPreference,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
    WorkspaceEmailSettings,
)
from .serializers import (
    NotificationPreferenceSerializer,
    NotificationSerializer,
    ProjectNotificationPreferenceSerializer,
    UserNotificationSettingsSerializer,
    WorkspaceEmailSettingsSerializer,
)
from .services import get_or_create_default_preferences, get_or_create_notification_settings

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request


# Snooze presets (ADR-0216 §1). The client may send a preset key OR an explicit
# `until` ISO datetime; presets are resolved server-side so the "tomorrow 9am"
# anchor stays consistent and testable.
SNOOZE_PRESETS: tuple[str, ...] = ("1h", "3h", "tomorrow")


def _resolve_snooze_preset(preset: str, now: datetime.datetime) -> datetime.datetime | None:
    """Resolve a snooze preset key to an absolute datetime, or None if unknown.

    ``1h`` / ``3h`` are relative to ``now``; ``tomorrow`` is the next day at 09:00
    in the workspace timezone (``settings.TIME_ZONE``), returned as an aware UTC
    datetime. The workspace tz is used because the default ``auth.User`` carries
    no per-user timezone.
    """
    if preset == "1h":
        return now + datetime.timedelta(hours=1)
    if preset == "3h":
        return now + datetime.timedelta(hours=3)
    if preset == "tomorrow":
        try:
            tz = datetime.UTC if not settings.TIME_ZONE else ZoneInfo(settings.TIME_ZONE)
        except Exception:
            tz = datetime.UTC
        local_tomorrow = (now.astimezone(tz) + datetime.timedelta(days=1)).replace(
            hour=9, minute=0, second=0, microsecond=0
        )
        return local_tomorrow.astimezone(datetime.UTC)
    return None


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="unread_only",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When `true` (or `1`), return only unread, non-archived "
                    "notifications. Mutually exclusive with `archived`."
                ),
            ),
            OpenApiParameter(
                name="archived",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When `true` (or `1`), return only archived notifications. "
                    "The default list (neither param set) excludes archived rows."
                ),
            ),
            OpenApiParameter(
                name="snoozed",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When `true` (or `1`), return only currently-snoozed rows "
                    "(`snoozed_until` in the future). Every other view EXCLUDES "
                    "currently-snoozed rows — including the unread-count query — "
                    "so a deferred notification does not increment the bell badge."
                ),
            ),
            OpenApiParameter(
                name="category",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                enum=list(CATEGORIES),
                description=(
                    "Filter to one derived category: `mentions`, `tasks`, "
                    "`signals`, or `project`. Orthogonal to the read-state "
                    "filters. `mentions` also matches mention-sourced rows."
                ),
            ),
        ],
    ),
)
class NotificationViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet[Notification],
):
    """Per-user notification inbox.

    GET    /me/notifications/            ?unread_only=true&archived=true&snoozed=true&category=tasks
    GET    /me/notifications/{id}/
    PATCH  /me/notifications/{id}/                { is_read: bool, is_archived: bool }
    POST   /me/notifications/{id}/snooze/         { until: iso } | { preset: 1h|3h|tomorrow }
    POST   /me/notifications/mark-all-read/

    All reads/writes are auto-scoped to the authenticated user — no cross-user
    access possible by construction (queryset filters by recipient=request.user).
    """

    serializer_class = NotificationSerializer
    permission_classes: list[type[BasePermission]] = [IsAuthenticated]
    lookup_field = "pk"

    def get_serializer_context(self) -> dict[str, Any]:
        """Precompute the recipient's member-project set once per response.

        NotificationSerializer.get_snippet redacts the body for a recipient who
        is not a current member of the mention's source project (#514 — program
        mentions can reach sibling-project members). Resolving the membership set
        here keeps the inbox list at one query instead of one per row.
        """
        context: dict[str, Any] = dict(super().get_serializer_context())
        user = self.request.user
        if user.is_authenticated:
            from trueppm_api.apps.access.models import ProjectMembership

            context["member_project_ids"] = set(
                ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
                    "project_id", flat=True
                )
            )
        return context

    def get_queryset(self) -> QuerySet[Notification]:
        user = self.request.user
        if not user.is_authenticated:
            return Notification.objects.none()
        qs = Notification.objects.filter(recipient=user).select_related(
            "mention",
            "mention__task_comment",
            "mention__mentioner",
            "mention__mentioned_user",
            "project",
        )
        params = self.request.query_params
        now = timezone.now()
        snoozed_only = params.get("snoozed", "").lower() in ("1", "true")
        unread_only = params.get("unread_only", "").lower() in ("1", "true")
        archived_only = params.get("archived", "").lower() in ("1", "true")

        if snoozed_only:
            # The "Snoozed" chip: rows deferred to the future, still active.
            qs = qs.filter(snoozed_until__gt=now, is_archived=False)
        else:
            # Every non-snoozed view hides rows still inside their snooze window;
            # they reappear automatically once snoozed_until passes (pure query-
            # time filter, ADR-0216 §1). Applied BEFORE the read-state branch so
            # the unread-count path (unread_only=true) also excludes snoozed rows
            # — otherwise a deferred notification would still light the bell badge.
            qs = qs.filter(Q(snoozed_until__isnull=True) | Q(snoozed_until__lte=now))
            if unread_only:
                qs = qs.filter(is_read=False, is_archived=False)
            elif archived_only:
                qs = qs.filter(is_archived=True)
            else:
                # Default list excludes archived
                qs = qs.filter(is_archived=False)

        # Derived category filter (ADR-0216 §3). The mapping lives in
        # categories.py so this filter and the serializer's category field share
        # one source of truth. `mentions` additionally matches mention-sourced
        # rows (blank event_type + mention FK). An unknown category maps to an
        # empty event-type set → matches nothing.
        category = params.get("category", "").strip().lower()
        if category:
            event_types = event_types_for_category(category)
            category_q = Q(event_type__in=event_types)
            if category == CATEGORY_MENTIONS:
                category_q |= Q(mention__isnull=False)
            qs = qs.filter(category_q)

        return qs.order_by("-created_at")

    @extend_schema(
        request={
            "application/json": {
                "type": "object",
                "properties": {
                    "preset": {"type": "string", "enum": list(SNOOZE_PRESETS)},
                    "until": {
                        "type": "string",
                        "format": "date-time",
                        "nullable": True,
                    },
                },
            }
        },
        responses=NotificationSerializer,
    )
    @action(detail=True, methods=["post"], url_path="snooze")
    def snooze(self, request: Request, pk: str | None = None) -> Response:
        """Snooze (or un-snooze) a single notification (ADR-0216 §1).

        Body accepts EITHER ``{"preset": "1h"|"3h"|"tomorrow"}`` OR
        ``{"until": "<iso datetime>"}``. Pass ``{"until": null}`` (or an empty
        body) to un-snooze — clearing ``snoozed_until`` returns the row to the
        inbox immediately. Idempotent: re-snoozing overwrites the timestamp.

        Looks the row up recipient-scoped directly (not via the filtered
        get_queryset) so a currently-snoozed row can still be re-snoozed or
        un-snoozed — the default queryset hides snoozed rows.
        """
        user = request.user
        notification = get_object_or_404(Notification, pk=pk, recipient=user)
        now = timezone.now()

        preset = request.data.get("preset")
        if preset:
            until = _resolve_snooze_preset(preset, now)
            if until is None:
                return Response(
                    {"detail": f"preset must be one of {list(SNOOZE_PRESETS)}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        elif "until" in request.data:
            raw = request.data.get("until")
            if raw in (None, ""):
                until = None  # explicit un-snooze
            else:
                parsed = parse_datetime(raw) if isinstance(raw, str) else None
                if parsed is None:
                    return Response(
                        {"detail": "until must be an ISO 8601 datetime or null."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # Anchor a naive timestamp to the current timezone rather than
                # letting Django emit a naive-datetime warning / compare wrong.
                if timezone.is_naive(parsed):
                    parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
                until = parsed
        else:
            return Response(
                {"detail": "Provide a 'preset' or an 'until' datetime (null to un-snooze)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        notification.snoozed_until = until
        notification.save(update_fields=["snoozed_until"])
        serializer = self.get_serializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def perform_update(self, serializer: Any) -> None:
        instance: Notification = serializer.instance
        was_read = instance.is_read
        updated = serializer.save()
        # Stamp read_at on transition unread → read; never reset to None.
        if updated.is_read and not was_read:
            updated.read_at = timezone.now()
            updated.save(update_fields=["read_at"])

    @action(detail=False, methods=["post"], url_path="mark-all-read")
    def mark_all_read(self, request: Request) -> Response:
        """Mark every unread notification for this user as read in one update."""
        user = request.user
        if not user.is_authenticated:
            return Response({"updated": 0}, status=status.HTTP_200_OK)
        now = timezone.now()
        updated = Notification.objects.filter(
            recipient=user, is_read=False, is_archived=False
        ).update(is_read=True, read_at=now)
        return Response({"updated": updated}, status=status.HTTP_200_OK)


class NotificationPreferenceViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet[NotificationPreference],
):
    """Per-user (event_type, channel) toggle matrix.

    GET    /me/notification-preferences/
    PATCH  /me/notification-preferences/{id}/     { enabled: bool }

    First GET backfills DEFAULT_PREFERENCES (Priya's email-OFF flip from V2 VoC)
    if the user has no rows yet — lazy initialization so user-create doesn't
    have to know about this table.
    """

    serializer_class = NotificationPreferenceSerializer
    permission_classes: list[type[BasePermission]] = [IsAuthenticated]

    def get_queryset(self) -> QuerySet[NotificationPreference]:
        user = self.request.user
        if not user.is_authenticated:
            return NotificationPreference.objects.none()
        return NotificationPreference.objects.filter(user=user).order_by("event_type", "channel")

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        if request.user.is_authenticated:
            get_or_create_default_preferences(request.user)
        return super().list(request, *args, **kwargs)

    def perform_update(self, serializer: Any) -> None:
        """Disallow channel / event_type / user changes — only enabled toggle.

        In practice unreachable (get_queryset already restricts to user=request.user
        so cross-user PATCH 404s), but the guard is defense-in-depth.
        """
        instance: NotificationPreference = serializer.instance
        if instance.user_id != self.request.user.pk:
            # DRF's PermissionDenied → 403; bare PermissionError raises 500.
            raise PermissionDenied("Cannot modify another user's preferences.")
        serializer.save()

    @action(detail=False, methods=["post"], url_path="apply-preset")
    def apply_preset(self, request: Request) -> Response:
        """Apply a wholesale preference preset (#855) and return the new matrix.

        Body: ``{"preset": "signal_only" | "everything"}``.

        - ``signal_only`` — the contributor profile: in-app ON for the two
          attention-worthy events (task.blocked, task.due_date_changed), every
          other (event, channel) row OFF. This is Priya's escape from a noisy
          default without auditing the full grid cell-by-cell.
        - ``everything`` — restore the enabled state from DEFAULT_PREFERENCES.

        Implemented as a bulk write over the existing per-(event, channel) rows
        rather than a new "profile" model, so the matrix stays the single source
        of truth and the data-driven settings page (ADR-0085) needs no special
        casing. Scoped to ``request.user`` by construction.
        """
        user = request.user
        if not user.is_authenticated:
            raise PermissionDenied("Authentication required.")
        preset = request.data.get("preset")
        if preset not in ("signal_only", "everything"):
            return Response(
                {"detail": "preset must be 'signal_only' or 'everything'."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Wrap get_or_create → read → bulk_update in a single atomic block so a
        # concurrent second apply_preset on the same user (e.g. rapid double-click)
        # cannot interleave a partial write — either the full preset lands or none
        # of it does (#1317 atomicity finding).
        with transaction.atomic():
            # Ensure the full row set exists before we toggle (a brand-new user may
            # have no rows yet — same lazy backfill the list view performs).
            get_or_create_default_preferences(user)
            prefs = list(NotificationPreference.objects.filter(user=user))
            if preset == "signal_only":
                for p in prefs:
                    p.enabled = (
                        p.channel == NotificationChannel.IN_APP
                        and p.event_type in SIGNAL_ONLY_EVENTS
                    )
            else:  # everything
                default_map = {(e, c): enabled for (e, c, enabled) in DEFAULT_PREFERENCES}
                for p in prefs:
                    p.enabled = default_map.get((p.event_type, p.channel), p.enabled)
            NotificationPreference.objects.bulk_update(prefs, ["enabled"])
        serializer = self.get_serializer(self.get_queryset(), many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Project-scoped notification preferences (#522)
# ---------------------------------------------------------------------------


_VALID_EVENT_TYPES = {choice.value for choice in ProjectNotificationEventType}
_VALID_CHANNELS = {choice.value for choice in ProjectNotificationChannel}


def _merge_matrix(
    stored: dict[str, dict[str, bool]],
    incoming: dict[str, dict[str, bool]],
) -> dict[str, dict[str, bool]]:
    """Merge `incoming` into a copy of `stored`, preferring incoming values.

    The PATCH semantics are partial: a client toggling a single cell should
    not have to repost the full 36-cell grid. The defaults dict is also
    overlaid on the response so a freshly added event type is populated for
    a user whose row predates the event.

    Unknown event-type / channel keys, and non-bool leaves, are dropped (#675):
    the serializer now rejects them on write, but a row persisted before that
    validation shipped could still carry garbage. Filtering here keeps it out of
    the GET response and the dispatcher's view even on an un-migrated row, and
    matches the dispatcher's `_matrix_cell` so the echo and the effective value
    agree — defense-in-depth on top of the one-shot cleanup migration.
    """
    merged: dict[str, dict[str, bool]] = {
        evt: dict(chans) for evt, chans in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items()
    }
    for source in (stored, incoming):
        for evt, chans in source.items():
            if evt not in _VALID_EVENT_TYPES or not isinstance(chans, dict):
                continue
            row = merged.setdefault(evt, {})
            for ch, enabled in chans.items():
                if ch in _VALID_CHANNELS and isinstance(enabled, bool):
                    row[ch] = enabled
    return merged


class ProjectNotificationPreferenceView(IdempotencyMixin, APIView):
    """GET/PATCH per-project notification preferences for the current user.

    Mounted at ``/api/v1/projects/<pk>/notification-preferences/``. Any project
    member may read and update their own preferences — there is no admin
    surface to edit another member's routing (the design intentionally keeps
    this user-controlled per ADR-0075's "each user owns their notification
    contract" rule).

    GET returns a defaults-overlaid view so a new event type added on the
    server is populated even for a user whose row pre-dates the addition.
    PATCH accepts a partial matrix and merges it onto the stored document.
    """

    permission_classes = [IsAuthenticated, IsProjectMember]

    def _get_project(self, request: Request, pk: str) -> Project:
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        return project

    def _get_or_create_pref(self, project: Project, user: Any) -> ProjectNotificationPreference:
        pref, _ = ProjectNotificationPreference.objects.get_or_create(project=project, user=user)
        return pref

    def get(self, request: Request, pk: str) -> Response:
        project = self._get_project(request, pk)
        pref = self._get_or_create_pref(project, request.user)
        # Overlay defaults so a newly added event type renders even when the
        # stored matrix predates it.
        merged = _merge_matrix(pref.matrix or {}, {})
        payload = ProjectNotificationPreferenceSerializer(pref).data
        payload["matrix"] = merged
        return Response(payload, status=status.HTTP_200_OK)

    def patch(self, request: Request, pk: str) -> Response:
        project = self._get_project(request, pk)
        pref = self._get_or_create_pref(project, request.user)
        serializer = ProjectNotificationPreferenceSerializer(pref, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)

        validated = serializer.validated_data
        if "matrix" in validated:
            # Merge so a partial cell update doesn't drop the rest of the grid.
            merged = _merge_matrix(pref.matrix or {}, validated["matrix"])
            pref.matrix = merged

        for field in ("paused", "quiet_hours_enabled", "quiet_hours_from", "quiet_hours_until"):
            if field in validated:
                setattr(pref, field, validated[field])
        pref.save()

        payload = ProjectNotificationPreferenceSerializer(pref).data
        payload["matrix"] = _merge_matrix(pref.matrix or {}, {})
        return Response(payload, status=status.HTTP_200_OK)


class MyNotificationSettingsView(IdempotencyMixin, APIView):
    """GET/PATCH the authenticated user's account-wide notification settings.

    Mounted at ``/api/v1/me/notification-settings/`` — the authoritative read/write
    surface for the Do-Not-Disturb switch (#1707, ADR-0292). The same
    ``dnd_enabled`` value is projected read-only onto ``/auth/me`` so the web
    current-user query carries it without a second request.

    Self-scoped by construction: the row is always ``request.user``'s own
    (``get_or_create`` on the caller), there is no object id in the path, and there
    is no way to address another user's settings — so there is no IDOR surface and
    no admin edit path, mirroring ADR-0075's "each user owns their notification
    contract" rule.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: UserNotificationSettingsSerializer})
    def get(self, request: Request) -> Response:
        settings_row = get_or_create_notification_settings(request.user)
        return Response(
            UserNotificationSettingsSerializer(settings_row).data,
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        request=UserNotificationSettingsSerializer,
        responses={200: UserNotificationSettingsSerializer},
    )
    def patch(self, request: Request) -> Response:
        settings_row = get_or_create_notification_settings(request.user)
        serializer = UserNotificationSettingsSerializer(
            settings_row, data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_200_OK)


def _email_settings_payload(obj: WorkspaceEmailSettings, *, can_edit: bool) -> dict[str, Any]:
    """Serialize the singleton for the client, adding the read-only status flags.

    The password is never included (write-only serializer field); the response
    carries only ``password_is_set``. ``configured_via`` and ``host_configured``
    preserve back-compat with the #639 read-only status hook.
    """
    data: dict[str, Any] = dict(WorkspaceEmailSettingsSerializer(obj).data)
    data["can_edit"] = can_edit
    data["configured_via"] = (
        "database" if obj.transport_mode != EmailTransportMode.CLOUD else "environment"
    )
    data["host_configured"] = bool(obj.host)
    return data


class WorkspaceEmailSettingsView(IdempotencyMixin, APIView):
    """``/api/v1/workspace/email-settings/`` — writable workspace SMTP config.

    Upgrades the #639 read-only status page to the writable surface (#712,
    ADR-0213). ``GET`` is org-admin readable so any workspace admin can see the
    posture; **writes** (``PUT``/``PATCH``) require the install operator
    (superuser) because the transport is installation-global — a single-project
    admin must not be able to repoint all outbound mail at an attacker relay
    (security review C1). The password is write-only and never echoed. A save is
    rejected (400) if the candidate transport can't be opened, so a bad config
    can't lock the workspace out of mail (validate-before-persist, ADR-0213 §3).
    """

    permission_classes = [IsAuthenticated, IsOrgAdmin]

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in ("PUT", "PATCH"):
            return [IsAuthenticated(), IsWorkspaceOperator()]
        return [IsAuthenticated(), IsOrgAdmin()]

    def get_throttles(self) -> list[Any]:
        # Throttle only the write path (each write re-opens a candidate SMTP
        # connection); GET is a cheap read the settings page polls.
        if self.request.method in ("PUT", "PATCH"):
            throttle = ScopedRateThrottle()
            throttle.scope = "email_settings"
            return [throttle]
        return super().get_throttles()

    def get(self, request: Request) -> Response:
        obj = WorkspaceEmailSettings.load()
        return Response(_email_settings_payload(obj, can_edit=bool(request.user.is_superuser)))

    def put(self, request: Request) -> Response:
        return self._update(request, partial=False)

    def patch(self, request: Request) -> Response:
        return self._update(request, partial=True)

    def _update(self, request: Request, *, partial: bool) -> Response:
        obj = WorkspaceEmailSettings.load()
        serializer = WorkspaceEmailSettingsSerializer(
            obj, data=request.data, partial=partial, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        obj.refresh_from_db()
        return Response(_email_settings_payload(obj, can_edit=True))


class WorkspaceEmailTestView(IdempotencyMixin, APIView):
    """``POST /api/v1/workspace/email-settings/send-test/`` — send a test email.

    Sends a fixed test message to the **requesting operator's own address only**
    (server-derived — never a recipient from the request body, which would make
    this an authenticated open relay, security review M5) through the resolved
    transport. Synchronous so the admin gets immediate pass/fail feedback; a
    transport failure returns 502 with a generic message.
    """

    permission_classes = [IsAuthenticated, IsWorkspaceOperator]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "email_settings_probe"

    def post(self, request: Request) -> Response:
        from django.core.mail import EmailMessage

        from .email_backend import (
            resolve_email_connection,
            resolve_from_email,
            resolve_reply_to,
        )

        recipient = (getattr(request.user, "email", "") or "").strip()
        if not recipient:
            return Response(
                {"sent": False, "error": "Your account has no email address on file."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        obj = WorkspaceEmailSettings.load()
        try:
            connection = resolve_email_connection(obj)
            EmailMessage(
                subject="TruePPM test email",
                body=(
                    "This is a test message from your TruePPM workspace email "
                    "configuration. If you received it, outbound mail is working."
                ),
                from_email=resolve_from_email(obj),
                to=[recipient],
                reply_to=resolve_reply_to(obj) or None,
                connection=connection,
            ).send(fail_silently=False)
        except Exception:
            # Never surface the underlying transport exception (may echo creds).
            logger.warning("send-test: transport failed for %s", obj.transport_mode)
            return Response(
                {
                    "sent": False,
                    "error": "Could not send the test email. Check the transport configuration.",
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({"sent": True, "recipient": recipient})


class WorkspaceEmailHealthView(APIView):
    """``GET /api/v1/workspace/email-settings/health/`` — SPF/DKIM/DMARC posture.

    Live, bounded DNS TXT lookups on the persisted From-address domain (never a
    domain from request input). Operator-gated and tightly throttled — the
    lookups are an egress surface (ADR-0213 §4, security review M4/H3).
    """

    permission_classes = [IsAuthenticated, IsWorkspaceOperator]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "email_settings_probe"

    def get(self, request: Request) -> Response:
        from .email_health import check_deliverability

        obj = WorkspaceEmailSettings.load()
        return Response(check_deliverability(obj.from_email, obj.dkim_selector))
