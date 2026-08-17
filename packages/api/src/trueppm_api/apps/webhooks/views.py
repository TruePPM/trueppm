"""Views for webhook management API."""

from __future__ import annotations

import logging

import redis as redis_lib
from django.db import transaction
from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view, inline_serializer
from kombu.exceptions import (  # type: ignore[import-untyped]
    OperationalError as KombuOperationalError,
)
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.mixins import (
    CreateModelMixin,
    DestroyModelMixin,
    ListModelMixin,
    RetrieveModelMixin,
    UpdateModelMixin,
)
from rest_framework.pagination import CursorPagination
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
from trueppm_api.apps.webhooks.dispatch import build_delivery_body
from trueppm_api.apps.webhooks.models import (
    PING_EVENT_TYPE,
    Webhook,
    WebhookDelivery,
    _next_delivery_sequence,
)
from trueppm_api.apps.webhooks.serializers import (
    WebhookDeliverySerializer,
    WebhookSerializer,
)
from trueppm_api.apps.webhooks.tasks import deliver_webhook

logger = logging.getLogger(__name__)

_BROKER_ERRORS = (KombuOperationalError, ConnectionError, redis_lib.ConnectionError)


class WebhookDeliveryCursorPagination(CursorPagination):
    """Depth-independent pagination for a webhook's delivery log (#1317).

    The delivery history grows without bound — one row per event fired — and the
    previous hard ``[:50]`` slice could only ever surface the newest 50 with no
    way to page back. A created_at cursor is stable under the concurrent inserts
    the dispatcher produces. Mirrors AuditEventCursorPagination.
    """

    ordering = "-created_at"
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


# The real 200 body of a webhook's delivery log. Declared once and shared by the
# project- and program-scoped viewsets so both publish the identical component
# (two `inline_serializer` calls with the same name would be a duplicate-component
# hazard). This action paginates with a CURSOR while its viewset's own
# pagination_class is page-number, and drf-spectacular's auto-wrap reads the class
# attribute — so a `many=True` response was wrapped in the page-number envelope and
# published `count` as *required* for a body that never carries one. Same defect
# class as #2583's named instances: a client typing `count` as non-optional breaks
# on first call. Declare the envelope rather than lean on a heuristic that cannot
# see which paginator actually runs.
WEBHOOK_DELIVERY_PAGE = inline_serializer(
    name="WebhookDeliveryCursorPage",
    fields={
        "next": serializers.URLField(allow_null=True),
        "previous": serializers.URLField(allow_null=True),
        "results": WebhookDeliverySerializer(many=True),
    },
)


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
        # `deliveries` exposes the full event payload (task notes, comment
        # snippets, assignee emails) of every event ever sent (#903). That is
        # information disclosure beyond plain project membership, so it is
        # Admin-only — consistent with webhook create/update/delete/test, which
        # are already Admin-gated (only an Admin could have created the webhook).
        if self.action in (
            "create",
            "update",
            "partial_update",
            "destroy",
            "test_ping",
            "deliveries",
        ):
            return [IsAuthenticated(), IsProjectAdmin()]
        return [IsAuthenticated(), IsProjectMember()]

    def get_queryset(self) -> QuerySet[Webhook]:
        project_pk = self.kwargs["project_pk"]
        return (
            Webhook.objects.filter(project_id=project_pk)
            .select_related("project", "created_by")
            .order_by("-created_at")
        )

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

    @extend_schema(
        summary="Send a test webhook ping",
        responses={
            202: inline_serializer(
                name="WebhookTestPingResponse",
                fields={"delivery_id": serializers.CharField()},
            )
        },
    )
    @action(detail=True, methods=["post"], url_path="test")
    def test_ping(self, request: Request, **kwargs: object) -> Response:
        """Send a test ping to the webhook URL.

        The ping takes exactly the same path as a real delivery: it renders through
        the subscription's registered format, is signed identically, and consumes a
        sequence number with a matching ``_meta.sequence``. A test therefore fails
        wherever a real delivery would, and never shows up as a gap in the
        consumer's sequence counter.

        Returns 202 with the ``delivery_id``. That acknowledges the *enqueue*, not
        the receiver's answer — read the ``deliveries`` action back for that row's
        terminal ``status`` and ``response_status`` to learn what the receiver said.
        """
        # Building the ping inline (rather than through the provider) was how a
        # slack-format webhook — the UI default — got sent a body Slack rejects with
        # 400 invalid_payload while the API reported success on the 202 (#2884).
        webhook = self.get_object()
        sequence = _next_delivery_sequence(webhook.pk)
        body = build_delivery_body(
            webhook,
            PING_EVENT_TYPE,
            {"event": PING_EVENT_TYPE, "webhook_id": str(webhook.pk)},
            sequence,
        )
        delivery = WebhookDelivery.objects.create(
            webhook=webhook,
            event_type=PING_EVENT_TYPE,
            payload=body,
            sequence_number=sequence,
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

    @extend_schema(
        summary="List recent webhook deliveries",
        responses={200: WEBHOOK_DELIVERY_PAGE},
        # Pinned because declaring the envelope changes what drf-spectacular
        # thinks this operation is. It derives the operationId's `_list`/
        # `_retrieve` suffix from whether the 200 is a ``many=True`` serializer,
        # so switching to an object envelope silently renamed
        # ``…_deliveries_list`` to ``…_deliveries_retrieve`` — and operationId is
        # the *method name* in a generated client. Fixing a broken response type
        # by breaking every caller's method name would trade one #2583 for
        # another, so the shipped id is held fixed.
        operation_id="v1_projects_webhooks_deliveries_list",
    )
    @action(detail=True, methods=["get"], url_path="deliveries")
    def deliveries(self, request: Request, **kwargs: object) -> Response:
        """List deliveries for this webhook, newest first (cursor-paginated, #1317).

        A bare ``GET`` returns the most recent page; follow ``next`` to page
        back through history. Instantiates the cursor paginator directly rather
        than going through ``self.paginator`` (the viewset default is page-number
        for the webhook CRUD list — the delivery log wants a cursor).
        """
        webhook = self.get_object()
        qs = WebhookDelivery.objects.filter(webhook=webhook)
        paginator = WebhookDeliveryCursorPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        serializer = WebhookDeliverySerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)


@extend_schema_view(
    # Annotates the INHERITED action rather than redefining it. A single pinned
    # operation_id on the base class would publish the same id on both the
    # project- and program-scoped paths — a duplicate-operationId collision — so
    # each concrete viewset needs its own. `extend_schema_view` does that without
    # a subclass override, which would duplicate the handler for no runtime
    # reason. See WebhookViewSet.deliveries for why the envelope must be explicit
    # and why the id is pinned at all (#2583).
    deliveries=extend_schema(
        summary="List recent webhook deliveries",
        responses={200: WEBHOOK_DELIVERY_PAGE},
        operation_id="v1_programs_webhooks_deliveries_list",
    )
)
class ProgramWebhookViewSet(WebhookViewSet):
    """CRUD for outbound webhooks scoped to a program (ADR-0076).

    A program-scoped webhook fires for events on any project within the program.
    Inherits the test/deliveries actions and the rendering/dispatch substrate
    from WebhookViewSet; only the scope resolution and RBAC ladder change:
    list/retrieve require Program Viewer+ (IsProgramMember), mutations require
    Program Admin+ (IsProgramAdmin).
    """

    def get_permissions(self) -> list[BasePermission]:
        # `deliveries` exposes the full event payload (task notes, comment
        # snippets, assignee emails) of every event ever sent (#903). That is
        # information disclosure beyond plain project membership, so it is
        # Admin-only — consistent with webhook create/update/delete/test, which
        # are already Admin-gated (only an Admin could have created the webhook).
        if self.action in (
            "create",
            "update",
            "partial_update",
            "destroy",
            "test_ping",
            "deliveries",
        ):
            return [IsAuthenticated(), IsProgramAdmin()]
        return [IsAuthenticated(), IsProgramMember()]

    def get_queryset(self) -> QuerySet[Webhook]:
        program_pk = self.kwargs["program_pk"]
        return (
            Webhook.objects.filter(program_id=program_pk)
            .select_related("program", "created_by")
            .order_by("-created_at")
        )

    def perform_create(self, serializer: BaseSerializer[Webhook]) -> None:
        program_pk = self.kwargs["program_pk"]
        try:
            program = Program.objects.get(pk=program_pk, is_deleted=False)
        except Program.DoesNotExist:
            from rest_framework.exceptions import NotFound

            raise NotFound("Program not found.") from None

        self.check_object_permissions(self.request, program)
        serializer.save(program=program, created_by=self.request.user)
