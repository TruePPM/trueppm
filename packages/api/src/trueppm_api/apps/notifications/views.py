"""ViewSets for the per-user notification inbox + preferences (ADR-0075)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response

from .models import Notification, NotificationPreference
from .serializers import NotificationPreferenceSerializer, NotificationSerializer
from .services import get_or_create_default_preferences

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request


class NotificationViewSet(
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
