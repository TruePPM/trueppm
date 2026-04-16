"""Views for webhook management API."""

from __future__ import annotations

from django.db.models import QuerySet
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.mixins import (
    CreateModelMixin,
    DestroyModelMixin,
    ListModelMixin,
    RetrieveModelMixin,
    UpdateModelMixin,
)
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import IsProjectAdmin, IsProjectMember
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery
from trueppm_api.apps.webhooks.serializers import (
    WebhookDeliverySerializer,
    WebhookSerializer,
)


class WebhookViewSet(
    CreateModelMixin,
    RetrieveModelMixin,
    UpdateModelMixin,
    DestroyModelMixin,
    ListModelMixin,
    GenericViewSet[Webhook],
):
    """CRUD for outbound webhooks scoped to a project.

    List/retrieve: requires Viewer+ (IsProjectMember).
    Create/update/delete: requires Admin+ (IsProjectAdmin).
    """

    serializer_class = WebhookSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "update", "partial_update", "destroy", "test_ping"):
            return [IsAuthenticated(), IsProjectAdmin()]
        return [IsAuthenticated(), IsProjectMember()]

    def get_queryset(self) -> QuerySet[Webhook]:
        project_pk = self.kwargs["project_pk"]
        return Webhook.objects.filter(project_id=project_pk).order_by("-created_at")

    def perform_create(self, serializer: BaseSerializer[Webhook]) -> None:
        project_pk = self.kwargs["project_pk"]
        try:
            project = Project.objects.get(pk=project_pk, is_deleted=False)
        except Project.DoesNotExist:
            from rest_framework.exceptions import NotFound

            raise NotFound("Project not found.") from None

        # Check object-level permission.
        self.check_object_permissions(self.request, project)

        serializer.save(project=project, created_by=self.request.user)

    def perform_update(self, serializer: BaseSerializer[Webhook]) -> None:
        serializer.save()

    def get_object(self) -> Webhook:
        obj: Webhook = super().get_object()
        # Object-level permission check against the project.
        self.check_object_permissions(self.request, obj.project)
        return obj

    @action(detail=True, methods=["post"], url_path="test")
    def test_ping(self, request: Request, **kwargs: object) -> Response:
        """Send a test ping event to the webhook URL."""
        webhook = self.get_object()
        from django.db import transaction

        from trueppm_api.apps.webhooks.models import WebhookDelivery
        from trueppm_api.apps.webhooks.tasks import deliver_webhook

        delivery = WebhookDelivery.objects.create(
            webhook=webhook,
            event_type="ping",
            payload={"event": "ping", "webhook_id": str(webhook.pk)},
        )
        # Defer dispatch until the delivery row is committed so the task never
        # races against an uncommitted row.  If the broker is down the drain
        # task picks it up within _DRAIN_ORPHAN_MINUTES.
        delivery_id = str(delivery.pk)
        transaction.on_commit(lambda: deliver_webhook.delay(delivery_id))
        return Response(
            {"delivery_id": delivery_id},
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=["get"], url_path="deliveries")
    def deliveries(self, request: Request, **kwargs: object) -> Response:
        """List recent deliveries for this webhook."""
        webhook = self.get_object()
        deliveries = WebhookDelivery.objects.filter(webhook=webhook).order_by("-created_at")[:50]
        serializer = WebhookDeliverySerializer(deliveries, many=True)
        return Response(serializer.data)
