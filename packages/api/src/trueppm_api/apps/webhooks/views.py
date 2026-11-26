"""Views for webhook management API."""

from __future__ import annotations

import logging

import redis as redis_lib
from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone
from django.utils.translation import gettext as _
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
    inline_serializer,
)
from kombu.exceptions import (
    OperationalError as KombuOperationalError,
)
from rest_framework import serializers, status
from rest_framework.authentication import BaseAuthentication
from rest_framework.decorators import action
from rest_framework.exceptions import (
    APIException,
    AuthenticationFailed,
    PermissionDenied,
    ValidationError,
)
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
from rest_framework.throttling import UserRateThrottle
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import (
    IsNotFullTokenAuthenticated,
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.authentication import WebhookManageApiTokenAuthentication
from trueppm_api.apps.projects.models import ApiToken, Program, Project
from trueppm_api.apps.webhooks.dispatch import build_delivery_body
from trueppm_api.apps.webhooks.models import (
    PING_EVENT_TYPE,
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
    WebhookEditor,
    WebhookTokenEditor,
    _next_delivery_sequence,
)
from trueppm_api.apps.webhooks.permissions import IsNotNarrowScopedToken
from trueppm_api.apps.webhooks.serializers import (
    WebhookCreateResponseSerializer,
    WebhookDeliverySerializer,
    WebhookSerializer,
)
from trueppm_api.apps.webhooks.tasks import deliver_webhook
from trueppm_api.core.credential_cutoff import lock_and_recheck_credential_cutoff
from trueppm_api.core.openapi import CURSOR_PAGINATION_PARAMETERS

logger = logging.getLogger(__name__)

_BROKER_ERRORS = (KombuOperationalError, ConnectionError, redis_lib.ConnectionError)


def _record_token_editor(request: Request, webhook: Webhook | None) -> None:
    """Record the API token behind a durable-grant-shaped webhook write (#2414).

    Lets revoking that one token deactivate exactly the webhooks it put in place
    (``deactivate_webhooks_set_by_token``); a session or JWT write records nothing
    here (``WebhookEditor`` already names the person). Append-only, like
    ``WebhookEditor``.
    """
    from trueppm_api.apps.projects.models import ApiToken

    token = getattr(request, "auth", None)
    if webhook is not None and isinstance(token, ApiToken):
        WebhookTokenEditor.objects.update_or_create(webhook=webhook, api_token=token)


def _lock_credentials_for_webhook_grant(request: Request) -> None:
    """Serialize a durable-grant webhook write against both credential revocations.

    First the owner's ``UserProfile`` lock (``lock_and_recheck_credential_cutoff``,
    #4839: a password-reset sweep). Then, for an API-token caller, the token's own
    row, re-reading ``revoked_at`` under the lock: revoking *one* token
    (``MyApiTokenViewSet.destroy``) never touches the profile, so the profile lock
    alone cannot order it against this write. The request already authenticated, so
    without this a revoke committing between authentication and this write's commit
    runs ``deactivate_webhooks_set_by_token`` under READ COMMITTED before the
    ``WebhookTokenEditor`` row exists, and the webhook stays live (#2414).

    - revoke first: its conditional ``UPDATE`` holds the row lock to commit; this
      ``SELECT ... FOR UPDATE`` waits, re-evaluates ``revoked_at IS NULL`` against
      the committed row, finds nothing, and the write is refused (401);
    - write first: revoke's ``UPDATE`` waits on this lock until the write commits,
      and its later ``deactivate`` statement (a fresh snapshot) sees the editor row.

    Lock order is profile then token on every path, and revoke takes only the token
    lock, so there is no inversion.

    Raises:
        AuthenticationFailed: the caller's token predates the cutoff, or was revoked
            after this request authenticated (HTTP 401).
    """
    lock_and_recheck_credential_cutoff(request)
    token = getattr(request, "auth", None)
    if (
        isinstance(token, ApiToken)
        and not ApiToken.objects.select_for_update()
        .filter(pk=token.pk, revoked_at__isnull=True)
        .exists()
    ):
        raise AuthenticationFailed(_("This token has been revoked."))


class ReplayRefused(APIException):
    """409: the delivery is not dead-lettered, or its subscription is inactive."""

    status_code = status.HTTP_409_CONFLICT
    default_code = "delivery_not_replayable"
    default_detail = _("Only a failed delivery on an active webhook can be replayed.")


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
DELIVERY_STATUS_PARAMETER = OpenApiParameter(
    name="status",
    type=str,
    location=OpenApiParameter.QUERY,
    required=False,
    enum=list(DeliveryStatus.values),
    description="Only deliveries in this state. `failed` is the dead-letter list.",
)

WEBHOOK_DELIVERY_PAGE = inline_serializer(
    name="WebhookDeliveryCursorPage",
    fields={
        "next": serializers.URLField(allow_null=True),
        "previous": serializers.URLField(allow_null=True),
        "results": WebhookDeliverySerializer(many=True),
    },
)


# The 201 body carries the one-time `secret`; the shared Webhook schema does not
# declare it (the field is write_only, which is right for every read). Declared per
#: Both causes of the 403 the project-scoped create now answers. Declared as one string
#: because the two are indistinguishable on the wire — same status, bare ``detail`` — so
#: a client branches on the message either way, and publishing only one of them would
#: tell an integrator the other cannot happen.
#:
#: Used ONLY where `ProgramWebhookViewSet` overrides the declaration with its own. A
#: declaration on an inherited action that the subclass does not re-declare publishes on
#: BOTH paths — which also collides their pinned operationIds — so `update`,
#: `partial_update` and `destroy` are deliberately left undeclared here rather than
#: gaining a project-flavored 403 on the program routes. They are part of the wider
#: undeclared-403-on-DELETE gap recorded in the MR for #3414.
_ARCHIVED_OR_NOT_ADMIN = (
    "Caller is not a project Admin, or the project is archived (#3414) — archived "
    "plans are read-only, so a webhook cannot be added, edited, deleted or "
    "test-fired on one. Reading the webhook and its deliveries still works."
)


# viewset because one shared declaration would publish the same operationId on both
# the project- and program-scoped paths — a duplicate-operationId collision. Ids are
# pinned for the same reason as `deliveries`: operationId is the *method name* in a
# generated client, so fixing a response shape must not rename every caller's method
# (#2583).
class WebhookTestPingThrottle(UserRateThrottle):
    """Per-user cap on ``test_ping`` (#2936), fixed to the ``webhook_test`` scope.

    Deliberately a ``UserRateThrottle`` with a class-level ``scope`` rather than a
    ``ScopedRateThrottle``: the latter reads ``view.throttle_scope``, which is a
    per-VIEW attribute, so it cannot express a per-@action scope and silently falls
    back to no limit (#2402). Passed through ``@action(throttle_classes=...)``,
    which replaces the global default throttles for this action only.
    """

    scope = "webhook_test"


@extend_schema_view(
    create=extend_schema(
        summary="Register a webhook",
        responses={
            201: WebhookCreateResponseSerializer,
            403: OpenApiResponse(description=_ARCHIVED_OR_NOT_ADMIN),
        },
        operation_id="v1_projects_webhooks_create",
    ),
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

    # No broadcast by design (#4286): perform_create/perform_update/delete emit no board
    # event and there is no `webhook_*` WS type, because no live shared surface renders
    # webhook configuration (the settings page refetches on mount). If one ever does,
    # add the event then; do not treat the absence as an oversight. (A comment, not the
    # docstring: the docstring is published into the OpenAPI schema.)
    serializer_class = WebhookSerializer

    # Exempt from the generic Idempotency-Key path (ADR-0170): the create response
    # carries the one-time plaintext signing secret, which must never be persisted
    # in the idempotency store for replay. Mirrors ProjectApiTokenViewSet, and it is
    # the same reasoning #2885 encrypts the column for — storing the plaintext in
    # IdempotencyKey.response_body (a plain JSONField, retained for
    # IDEMPOTENCY_RETENTION_HOURS) would move the secret to another table rather than
    # remove it, and would re-serve it on replay, contradicting the documented
    # "returned exactly once" guarantee.
    idempotency_exempt = True

    # Single source for both the runtime guard below and the schema: the OpenAPI
    # hook reads this set to strip the token security schemes from these actions
    # (``get_permissions`` is invisible to schema generation, #4665).
    # `replay` re-sends a stored payload to the *current* url under a still-live secret:
    # it is allowed for a session or a `webhooks:manage` token and refused for a
    # full-access token (ADR-1485 D6, the #4461 reasoning).
    full_token_refused_actions = frozenset({"create", "update", "partial_update", "replay"})
    # Read by the OpenAPI hook alongside the set above: `deliveries` is the one action
    # a `webhooks:manage` token cannot reach (#2414).
    narrow_token_refused_actions = frozenset({"deliveries"})
    # Read by the route-table invariant (#2745): replay re-sends a stored payload and
    # writes only the delivery row, never project data, so it survives archiving.
    archived_write_exempt = {
        "replay": (
            "re-sends a stored dead-lettered payload and touches only the delivery row, "
            "not the project; failures from before archiving must stay recoverable, "
            "and the delivery history that lists them is readable while archived too"
        ),
    }

    def get_authenticators(self) -> list[BaseAuthentication]:
        # Prepended so a `webhooks:manage` token is recognized here and nowhere else
        # (#2414); every other bearer falls through to the default stack unchanged.
        return [WebhookManageApiTokenAuthentication(), *super().get_authenticators()]

    def get_permissions(self) -> list[BasePermission]:
        # `deliveries` exposes the full event payload (task notes, comment
        # snippets, assignee emails) of every event ever sent (#903). That is
        # information disclosure beyond plain project membership, so it is
        # Admin-only — consistent with webhook create/update/delete/test, which
        # are already Admin-gated (only an Admin could have created the webhook).
        if self.action == "deliveries":
            # A read. Archived projects stay readable, so no lifecycle gate here.
            return [IsAuthenticated(), IsProjectAdmin(), IsNotNarrowScopedToken()]
        if self.action == "replay":
            # Refused for a full-access token (it stays in full_token_refused_actions
            # for the schema), but with no lifecycle gate, like `deliveries`: a replay
            # re-sends a stored payload and changes no project state, and the dead
            # letters an archived project's webhook already holds must stay
            # recoverable.
            return [IsAuthenticated(), IsProjectAdmin(), IsNotFullTokenAuthenticated()]
        if self.action in self.full_token_refused_actions:
            # IsNotTokenAuthenticated (#4461): create mints a durable HMAC signing
            # secret, and update can repoint the delivery URL or rotate that secret
            # — both are the same "a leaked PAT should not be able to extend itself
            # with a new durable grant" shape #2939 already blocked for share links
            # and git-automation secrets. destroy/test_ping stay token-reachable:
            # deleting only shrinks what a leaked token can reach, and test_ping
            # sends no new credential anywhere.
            return [
                IsAuthenticated(),
                IsProjectAdmin(),
                IsProjectNotArchived(),
                IsNotFullTokenAuthenticated(),
            ]
        if self.action in ("destroy", "test_ping"):
            # IsProjectNotArchived fires in `has_permission` on these routes because the
            # URL names `project_pk` — the kwarg `_project_pk_from_view` reads (#3414).
            # `destroy` is gated like the rest since the archive bypass was scoped to
            # ProjectViewSet; before that, the router-minted action name alone was
            # enough to skip the check on every project-scoped viewset.
            return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]
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

        # Serialize against a password-reset sweep, which deactivates this user's
        # webhooks (#4839).
        _lock_credentials_for_webhook_grant(self.request)
        serializer.save(project=project, created_by=self.request.user)
        _record_token_editor(self.request, serializer.instance)

    def perform_update(self, serializer: BaseSerializer[Webhook]) -> None:
        """Record an editor when this write is durable-grant-shaped (#4461).

        Two cases upsert into ``WebhookEditor`` — never an overwrite, and
        nothing here ever removes a row once it exists:

        - ``url`` or ``secret`` is actually present in ``validated_data``:
          creating or repointing the durable grant itself. A project
          webhook's update has no registrant check (unlike the
          program-scoped viewset below), so any project Admin may repoint
          any project webhook's URL or rotate its secret; without this,
          ``revoke_personal_durable_grants``'s sweep could only match
          ``created_by`` and would miss exactly that case.
        - ``is_active`` is set to ``True`` on a currently-inactive row:
          **re-enabling** is durable-grant-shaped on its own, even with
          ``url``/``secret`` untouched. A disabled webhook (by this sweep,
          or by the auto-disable guard) still carries whatever ``url``/
          ``secret`` it had; a second hijacked session that does nothing
          but flip it back on restarts delivery to wherever it currently
          points, and that re-enabler must be recorded or their own future
          containment would miss the row. *Disabling* is deliberately NOT
          recorded — it only shrinks what is live, the opposite shape.
        """
        changed_credential_fields = {"url", "secret"} & set(serializer.validated_data)
        is_reenable = (
            serializer.validated_data.get("is_active") is True
            and serializer.instance is not None
            and not serializer.instance.is_active
        )
        if changed_credential_fields or is_reenable:
            _lock_credentials_for_webhook_grant(self.request)
        serializer.save()
        if changed_credential_fields or is_reenable:
            from typing import cast

            from django.contrib.auth.models import User

            # IsAuthenticated (already enforced by get_permissions) guarantees a
            # real user, never AnonymousUser; narrow for WebhookEditor.user's FK.
            WebhookEditor.objects.update_or_create(
                webhook=serializer.instance, user=cast(User, self.request.user)
            )
            _record_token_editor(self.request, serializer.instance)

    def _check_delivery_log_access(self, webhook: Webhook) -> None:
        """Hook for scope-specific delivery-log access. No extra gate at project scope."""

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
        request=None,
        responses={
            202: inline_serializer(
                name="WebhookTestPingResponse",
                fields={"delivery_id": serializers.CharField()},
            ),
            403: OpenApiResponse(
                description=(
                    "Caller lacks Admin on the webhook's scope. On a PROJECT webhook the "
                    "same status is also how an archived project refuses (#3414); the "
                    "program-scoped route has no archived state. Declared once because "
                    "this handler is shared by both viewsets."
                )
            ),
        },
    )
    @action(
        detail=True,
        methods=["post"],
        url_path="test",
        throttle_classes=[WebhookTestPingThrottle],
    )
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
        parameters=[*CURSOR_PAGINATION_PARAMETERS, DELIVERY_STATUS_PARAMETER],
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
        self._check_delivery_log_access(webhook)
        qs = WebhookDelivery.objects.filter(webhook=webhook)
        # `?status=failed` is the dead-letter list (ADR-1485 D6): permanently failed
        # deliveries, kept for DEAD_LETTER_RETENTION_DAYS and replayable.
        status_filter = request.query_params.get("status")
        if status_filter:
            if status_filter not in DeliveryStatus.values:
                raise ValidationError(
                    {
                        "status": _("Must be one of: %(v)s.")
                        % {"v": ", ".join(DeliveryStatus.values)}
                    }
                )
            qs = qs.filter(status=status_filter)
        paginator = WebhookDeliveryCursorPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        serializer = WebhookDeliverySerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    @extend_schema(
        summary="Replay a dead-lettered webhook delivery",
        request=None,
        responses={
            202: inline_serializer(
                name="WebhookDeliveryReplayResponse",
                fields={
                    "queued": serializers.BooleanField(),
                    "delivery_id": serializers.CharField(),
                },
            ),
            403: OpenApiResponse(
                description=(
                    "Caller lacks Admin on the webhook's scope, or the token is a "
                    "full-access (`api:full`) token: replay is for a session or a "
                    "`webhooks:manage` token."
                )
            ),
            404: OpenApiResponse(description="No such delivery on this webhook."),
            409: OpenApiResponse(
                description=(
                    "The delivery is not dead-lettered (`status` is not `failed`), or "
                    "the subscription is inactive, so a replay could not be sent."
                )
            ),
        },
    )
    @action(
        detail=True,
        methods=["post"],
        url_path=r"deliveries/(?P<delivery_id>[0-9a-fA-F-]{32,36})/replay",
        url_name="delivery-replay",
        throttle_classes=[WebhookTestPingThrottle],
    )
    def replay(self, request: Request, delivery_id: str, **kwargs: object) -> Response:
        """Re-send a permanently failed delivery to the webhook's current URL.

        At-least-once, same identity: the delivery keeps its ``delivery_id``
        (``X-TruePPM-Delivery``) and its per-subscription sequence number, so a
        consumer that already saw it deduplicates on those. Only a ``failed``
        delivery is replayable, and only while the subscription is active. The
        stored payload is re-sent byte for byte; the signature is recomputed.
        """
        webhook = self.get_object()
        self._check_delivery_log_access(webhook)
        with transaction.atomic():
            try:
                delivery = WebhookDelivery.objects.select_for_update().get(
                    pk=delivery_id, webhook=webhook
                )
            except WebhookDelivery.DoesNotExist:
                from rest_framework.exceptions import NotFound

                raise NotFound("Delivery not found.") from None
            if delivery.status != DeliveryStatus.FAILED or not webhook.is_active:
                raise ReplayRefused()
            # Back to the state a freshly written delivery has, created_at included.
            # The drain re-dispatches PENDING, attempt_count=0 rows older than
            # _DRAIN_ORPHAN_MINUTES; a replayed row keeping its original (old)
            # created_at would be re-dispatched by the next drain tick alongside the
            # on-commit enqueue below, so every replay would send twice. Restarting
            # the clock gives the enqueue the same head start a new delivery gets, and
            # a lost broker call is still drained, just after the usual window.
            # deliver_webhook's terminal-state guard makes a late second dispatch a
            # no-op.
            delivery.status = DeliveryStatus.PENDING
            delivery.attempt_count = 0
            delivery.response_status = None
            delivery.completed_at = None
            delivery.created_at = timezone.now()
            delivery.save(
                update_fields=[
                    "status",
                    "attempt_count",
                    "response_status",
                    "completed_at",
                    "created_at",
                ]
            )
            replay_id = str(delivery.pk)

            def _enqueue_replay() -> None:
                try:
                    deliver_webhook.delay(replay_id)
                except _BROKER_ERRORS:
                    logger.warning(
                        "replay: broker unavailable — delivery %s will be drained", replay_id
                    )

            # on-commit-ok: the PENDING row is committed first and drain_webhook_queue replays it
            transaction.on_commit(_enqueue_replay)
        return Response({"queued": True, "delivery_id": replay_id}, status=status.HTTP_202_ACCEPTED)


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
        parameters=[*CURSOR_PAGINATION_PARAMETERS, DELIVERY_STATUS_PARAMETER],
        responses={
            200: WEBHOOK_DELIVERY_PAGE,
            403: OpenApiResponse(
                description=(
                    "Not the webhook's creator (#4310). The delivery log replays past "
                    "payloads from every member project, so it is restricted to the "
                    "registrant even for another Program Admin."
                )
            ),
        },
        operation_id="v1_programs_webhooks_deliveries_list",
    ),
    create=extend_schema(
        summary="Register a webhook",
        responses={201: WebhookCreateResponseSerializer},
        operation_id="v1_programs_webhooks_create",
    ),
    update=extend_schema(
        summary="Replace a webhook",
        responses={
            200: WebhookSerializer,
            400: OpenApiResponse(description="Validation error."),
            403: OpenApiResponse(
                description=(
                    "Refused (#4310) unless the requester is the webhook's creator AND "
                    "still holds live ProjectMembership on every project the program "
                    "covers. Checked before validation, so a no-op update is refused too."
                )
            ),
        },
    ),
    partial_update=extend_schema(
        summary="Update a webhook",
        responses={
            200: WebhookSerializer,
            400: OpenApiResponse(description="Validation error."),
            403: OpenApiResponse(
                description=(
                    "Refused (#4310) unless the requester is the webhook's creator AND "
                    "still holds live ProjectMembership on every project the program "
                    "covers. Checked before validation, so a no-op PATCH is refused too."
                )
            ),
        },
    ),
)
class ProgramWebhookViewSet(WebhookViewSet):
    """CRUD for outbound webhooks scoped to a program (ADR-0076).

    A program-scoped webhook fires for events on any project within the program.
    Inherits the test/deliveries actions and the rendering/dispatch substrate
    from WebhookViewSet; only the scope resolution and RBAC ladder change:
    list/retrieve require Program Viewer+ (IsProgramMember). Create requires Program
    Admin+ (IsProgramAdmin). Update (PUT/PATCH) requires more than that (#4310): the
    requester must be the webhook'''s registrant (created_by) AND still hold live
    ProjectMembership on every project the program covers, checked in get_object
    before validation — refused with 403 otherwise, including a no-op PATCH. The
    delivery log is likewise restricted to the registrant, not to Admin+ generally.
    """

    def get_permissions(self) -> list[BasePermission]:
        # `deliveries` exposes the full event payload (task notes, comment
        # snippets, assignee emails) of every event ever sent (#903). That is
        # information disclosure beyond plain project membership, so it is
        # Admin-only — consistent with webhook create/update/delete/test, which
        # are already Admin-gated (only an Admin could have created the webhook).
        #
        # Lifecycle (#4014): a closed program's shell is read-only (#530), so
        # registering or re-pointing a webhook is refused like minting a program API
        # token. `destroy` is deliberately NOT gated: child projects keep accepting
        # writes on a closed program, so a program webhook keeps delivering their
        # events to an external URL, and deleting it is the only way to stop that
        # outbound flow without reopening the program — the same containment argument
        # as program token revocation. `test_ping` and `deliveries` touch no program
        # state and stay available for diagnosing a still-live webhook. `replay` is
        # the same: the webhook keeps delivering child-project events after close, so
        # its dead letters keep accruing and must stay replayable. It is refused for a
        # full-access token only.
        if self.action == "replay":
            return [IsAuthenticated(), IsProgramAdmin(), IsNotFullTokenAuthenticated()]
        if self.action in self.full_token_refused_actions:
            # IsNotFullTokenAuthenticated (#4461, #2414): see WebhookViewSet.get_permissions —
            # same durable-grant shape, mint/repoint/rotate only through a session
            # or JWT.
            return [
                IsAuthenticated(),
                IsProgramAdmin(),
                IsProgramNotClosed(),
                IsNotFullTokenAuthenticated(),
            ]
        if self.action in ("destroy", "test_ping", "deliveries"):
            if self.action == "deliveries":
                return [IsAuthenticated(), IsProgramAdmin(), IsNotNarrowScopedToken()]
            return [IsAuthenticated(), IsProgramAdmin()]
        return [IsAuthenticated(), IsProgramMember()]

    def get_object(self) -> Webhook:
        obj: Webhook = super().get_object()
        # #4310 (B2, option c): only the registrant, and only while still a live member
        # of every project the webhook covers, may change it. Checked before validation
        # so a no-op PATCH is refused too, and so a non-member cannot re-point the URL
        # and start receiving a member project's events.
        if self.action in ("update", "partial_update") and not self._can_edit(obj):
            raise PermissionDenied("Only the webhook's creator can edit it while a member.")
        return obj

    def _can_edit(self, webhook: Webhook) -> bool:
        if webhook.program_id is None:
            return False
        if webhook.created_by_id is None or webhook.created_by_id != self.request.user.pk:
            return False
        project_ids = set(
            Project.objects.filter(program_id=webhook.program_id, is_deleted=False).values_list(
                "pk", flat=True
            )
        )
        if not project_ids:
            return True
        live = set(
            ProjectMembership.live()
            .filter(user=self.request.user, project_id__in=project_ids)
            .values_list("project_id", flat=True)
        )
        return live == project_ids

    def get_queryset(self) -> QuerySet[Webhook]:
        program_pk = self.kwargs["program_pk"]
        return (
            Webhook.objects.filter(program_id=program_pk)
            .select_related("program", "created_by")
            .order_by("-created_at")
        )

    def _check_delivery_log_access(self, webhook: Webhook) -> None:
        # #4310 (B3): the delivery log replays past event payloads from every member
        # project, so it is limited to the webhook's registrant. Another Program Admin
        # gets 403 even though IsProgramAdmin passes. A NULL registrant fails closed.
        if webhook.created_by_id is None or webhook.created_by_id != self.request.user.pk:
            raise PermissionDenied("Only the webhook's creator can read its delivery log.")

    def perform_create(self, serializer: BaseSerializer[Webhook]) -> None:
        program_pk = self.kwargs["program_pk"]
        try:
            program = Program.objects.get(pk=program_pk, is_deleted=False)
        except Program.DoesNotExist:
            from rest_framework.exceptions import NotFound

            raise NotFound("Program not found.") from None

        self.check_object_permissions(self.request, program)
        _lock_credentials_for_webhook_grant(self.request)
        serializer.save(program=program, created_by=self.request.user)
        _record_token_editor(self.request, serializer.instance)
