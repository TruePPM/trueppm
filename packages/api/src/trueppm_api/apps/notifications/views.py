"""ViewSets for the per-user notification inbox + preferences (ADR-0075)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsOrgAdmin, IsProjectMember
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Project

from .models import (
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    Notification,
    NotificationPreference,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
)
from .serializers import (
    NotificationPreferenceSerializer,
    NotificationSerializer,
    ProjectNotificationPreferenceSerializer,
)
from .services import get_or_create_default_preferences

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request


class NotificationViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet[Notification],
):
    """Per-user notification inbox.

    GET    /me/notifications/                     ?unread_only=true&limit=50
    GET    /me/notifications/{id}/
    PATCH  /me/notifications/{id}/                { is_read: bool, is_archived: bool }
    POST   /me/notifications/mark-all-read/

    All reads/writes are auto-scoped to the authenticated user — no cross-user
    access possible by construction (queryset filters by recipient=request.user).
    """

    serializer_class = NotificationSerializer
    permission_classes: list[type[BasePermission]] = [IsAuthenticated]
    lookup_field = "pk"

    def get_queryset(self) -> QuerySet[Notification]:
        user = self.request.user
        if not user.is_authenticated:
            return Notification.objects.none()
        qs = Notification.objects.filter(recipient=user).select_related(
            "mention", "mention__task_comment", "mention__mentioner", "project"
        )
        unread_only = self.request.query_params.get("unread_only", "").lower() in ("1", "true")
        if unread_only:
            qs = qs.filter(is_read=False, is_archived=False)
        archived_only = self.request.query_params.get("archived", "").lower() in ("1", "true")
        if archived_only:
            qs = qs.filter(is_archived=True)
        elif not unread_only:
            # Default list excludes archived
            qs = qs.filter(is_archived=False)
        return qs.order_by("-created_at")

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


class EmailSettingsStatusView(APIView):
    """``GET /api/v1/workspace/email-settings/`` — read-only Email & SMTP status.

    Surfaces how TruePPM sends outbound mail (#639, ADR-0085 §5). The transport is
    configured via Django settings / Helm env (``EMAIL_BACKEND``, ``EMAIL_HOST``,
    ``DEFAULT_FROM_EMAIL`` …), so this endpoint exposes only the **safe** subset —
    never the SMTP password or username — for the workspace admin to confirm the
    From identity and that a host is configured. Org-admin gated. The writable SMTP
    config (transport switch, BYO credentials) is #712.
    """

    permission_classes = [IsAuthenticated, IsOrgAdmin]

    def get(self, request: Request) -> Response:
        from django.conf import settings

        backend = getattr(settings, "EMAIL_BACKEND", "") or ""
        host = getattr(settings, "EMAIL_HOST", "") or ""
        if "smtp" in backend.lower():
            transport = "smtp"
        elif "console" in backend.lower():
            transport = "console"
        elif "locmem" in backend.lower():
            transport = "in-memory"
        else:
            transport = backend.rsplit(".", 1)[-1] or "unknown"
        return Response(
            {
                "transport": transport,
                "host": host,
                "host_configured": bool(host),
                "port": getattr(settings, "EMAIL_PORT", None),
                "use_tls": bool(getattr(settings, "EMAIL_USE_TLS", False)),
                "use_ssl": bool(getattr(settings, "EMAIL_USE_SSL", False)),
                "from_email": getattr(settings, "DEFAULT_FROM_EMAIL", "") or "",
                "configured_via": "environment",
            }
        )
