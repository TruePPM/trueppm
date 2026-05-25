"""Views for webhook management API."""

from __future__ import annotations

import logging

import redis as redis_lib
from django.db import transaction
from django.db.models import QuerySet
from kombu.exceptions import (  # type: ignore[import-untyped]
    OperationalError as KombuOperationalError,
)
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

from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProjectAdmin,
    IsProjectMember,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery
from trueppm_api.apps.webhooks.serializers import (
    WebhookDeliverySerializer,
    WebhookSerializer,
)
from trueppm_api.apps.webhooks.tasks import deliver_webhook

logger = logging.getLogger(__name__)

_BROKER_ERRORS = (KombuOperationalError, ConnectionError, redis_lib.ConnectionError)


class WebhookViewSet(
    IdempotencyMixin,
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
        # Object-level permission check against the webhook's scope object —
        # the Project for project-scoped webhooks, the Program for program-scoped
        # ones (ADR-0076). The active permission classes (Is{Project,Program}*)
        # match because get_permissions is scope-specific per subclass.
        self.check_object_permissions(self.request, self._scope_object(obj))
        return obj

    def _scope_object(self, webhook: Webhook) -> Project | Program:
        """Return the Project or Program a webhook is scoped to (XOR)."""
        scope = webhook.program if webhook.program_id else webhook.project
        # The webhook_scope_xor DB constraint guarantees exactly one is set, so
        # scope is never None here — assert narrows the type for mypy.
        assert scope is not None
        return scope

    @action(detail=True, methods=["post"], url_path="test")
    def test_ping(self, request: Request, **kwargs: object) -> Response:
        """Send a test ping event to the webhook URL."""
        webhook = self.get_object()
        delivery = WebhookDelivery.objects.create(
            webhook=webhook,
            event_type="ping",
            payload={"event": "ping", "webhook_id": str(webhook.pk)},
        )
        # Defer dispatch until the delivery row is committed so the task never
        # races against an uncommitted row.  If the broker is down the delay()
        # call is a no-op — the delivery row stays PENDING and drain_webhook_queue
        # picks it up within _DRAIN_ORPHAN_MINUTES.
        delivery_id = str(delivery.pk)

        def _enqueue_ping() -> None:
            try:
                deliver_webhook.delay(delivery_id)
            except _BROKER_ERRORS:
                logger.warning(
                    "test_ping: broker unavailable — delivery %s will be drained",
                    delivery_id,
                )

        transaction.on_commit(_enqueue_ping)
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


class ProgramWebhookViewSet(WebhookViewSet):
    """CRUD for outbound webhooks scoped to a program (ADR-0076).

    A program-scoped webhook fires for events on any project within the program.
    Inherits the test/deliveries actions and the rendering/dispatch substrate
    from WebhookViewSet; only the scope resolution and RBAC ladder change:
    list/retrieve require Program Viewer+ (IsProgramMember), mutations require
    Program Admin+ (IsProgramAdmin).
    """

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "update", "partial_update", "destroy", "test_ping"):
            return [IsAuthenticated(), IsProgramAdmin()]
        return [IsAuthenticated(), IsProgramMember()]

    def get_queryset(self) -> QuerySet[Webhook]:
        program_pk = self.kwargs["program_pk"]
        return Webhook.objects.filter(program_id=program_pk).order_by("-created_at")

    def perform_create(self, serializer: BaseSerializer[Webhook]) -> None:
        program_pk = self.kwargs["program_pk"]
        try:
            program = Program.objects.get(pk=program_pk, is_deleted=False)
        except Program.DoesNotExist:
            from rest_framework.exceptions import NotFound

            raise NotFound("Program not found.") from None

        self.check_object_permissions(self.request, program)
        serializer.save(program=program, created_by=self.request.user)
