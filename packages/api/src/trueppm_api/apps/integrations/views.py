"""ViewSets for the integrations API (ADR-0049 §3).

Two surfaces live here:

- ``IntegrationCredentialViewSet`` — the per-user credentials store. Exposes
  list, upsert (connect/rotate), and delete (revoke); read-of-the-secret is
  intentionally absent and every action auto-scopes to ``request.user``.
- ``TaskLinkViewSet`` (#637) — git/PM links on a task, nested under
  ``/projects/{project_pk}/tasks/{task_pk}/links/`` with a synchronous refresh
  action. Scoped to project membership; write follows task-edit, read follows
  task-read.

Credentials URL contract:
    GET    /api/v1/me/credentials/
    POST   /api/v1/me/credentials/<provider>/
    DELETE /api/v1/me/credentials/<provider>/
"""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any, cast

from django.db import transaction
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle, ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectNotArchived,
    ProjectScopedViewSet,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Project, Task

from . import git_webhook_auth, providers
from .encryption import CredentialEncryptionError, decrypt_secret
from .git_automation_services import apply_git_event_to_card
from .models import BoardAutomation, IntegrationCredential, TaskLink
from .registry import TASK_LINK_PROVIDERS
from .serializers import (
    CredentialSummarySerializer,
    CredentialUpsertSerializer,
    CredentialVerificationErrorSerializer,
    GitAutomationConfigSerializer,
    GitAutomationUpdateSerializer,
    TaskLinkCredentialRequiredSerializer,
    TaskLinkSerializer,
    serialize_credential_summaries,
)

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request
    from rest_framework.serializers import BaseSerializer

    # Used only in ``cast("type[TaskLinkProvider]", ...)`` string annotations, so
    # it needs no runtime import (keeps ruff and CodeQL in agreement).
    from .registry import TaskLinkProvider


# Human-readable detail per ``VerifyResult.reason`` for the 422 body. The
# machine-readable ``reason`` is returned alongside so the client can branch
# without string-matching the prose.
_VERIFY_FAILURE_DETAIL: dict[str | None, str] = {
    "invalid_token": (
        "The provider rejected this token. Check it is valid, unexpired, and "
        "issued for the correct host."
    ),
    "provider_unreachable": (
        "Could not reach the provider to verify this token. Check the host URL and try again."
    ),
    "provider_timeout": "Verifying this token with the provider timed out. Try again.",
    "blocked_host": ("The host URL is not allowed — it resolves to a private or internal address."),
}


@extend_schema(tags=["me"])
class IntegrationCredentialViewSet(
    IdempotencyMixin, viewsets.GenericViewSet[IntegrationCredential]
):
    """Per-user integration credentials.

    Lookup is by ``provider`` key rather than the row PK so the URL is
    stable across rotations (rotating creates a new ciphertext but does
    not change the row identity from the client's perspective).
    """

    serializer_class = CredentialSummarySerializer
    permission_classes: list[type[BasePermission]] = [IsAuthenticated]
    lookup_field = "provider"
    lookup_url_kwarg = "provider"
    # Rate-limit the whole viewset under one per-user scope (#1551). connect/rotate
    # mint a fresh ciphertext and revoke/read/list all touch the credential store;
    # a shared 10/min bucket bounds credential-store abuse without a per-action idiom.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "credential_rotate"

    def get_queryset(self) -> QuerySet[IntegrationCredential]:
        """Restrict to the authenticated user's rows only.

        The queryset is the single permission boundary — list, retrieve,
        upsert, and delete all read through it, so cross-user access is
        impossible by construction.
        """
        user = self.request.user
        if not user.is_authenticated:
            return IntegrationCredential.objects.none()
        return IntegrationCredential.objects.filter(user=user)

    @extend_schema(responses={200: CredentialSummarySerializer(many=True)})
    def list(self, request: Request) -> Response:
        """Return one summary row per registered provider.

        Providers without a stored credential still appear (``exists=False``)
        so the page can render the "Not connected" state without two round-
        trips. The encrypted secret is never serialized.
        """
        queryset = list(self.get_queryset())
        payload = serialize_credential_summaries(request.user, queryset)
        return Response(CredentialSummarySerializer(payload, many=True).data)

    @extend_schema(
        request=CredentialUpsertSerializer,
        responses={
            200: CredentialSummarySerializer(many=True),
            422: CredentialVerificationErrorSerializer,
        },
    )
    def create(self, request: Request, provider: str | None = None) -> Response:
        """Connect or rotate the credential for ``provider``.

        ``create`` is a deliberate misnomer here: connect-and-rotate are
        the same upsert. The viewset uses ``create`` so the standard DRF
        action set names the route ``POST /<provider>/`` rather than
        ``POST /<provider>/rotate/``, which is what ADR-0049 §3 spells out.

        Before persisting, the PAT is verified against the provider (#677):
        we ping the provider's ``/user`` endpoint with the token so a wrong,
        expired, wrong-scope, or wrong-host token is rejected here with 422
        rather than silently accepted and discovered later by #637's status
        fetch. The plaintext is never written to the DB on a failed verify —
        ``upsert`` (and therefore encryption) is not reached.
        """
        provider_cls = TASK_LINK_PROVIDERS.get(provider) if provider is not None else None
        if provider is None or provider_cls is None:
            return Response(
                {"detail": f"Unknown provider {provider!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = CredentialUpsertSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        secret = serializer.validated_data["secret"]
        base_url = serializer.validated_data.get("base_url", "")

        # Gate the host BEFORE verify_token: verify ships the PAT to base_url, so
        # an attacker-controlled host must be rejected before the token is on the
        # wire (#902), not merely have its 422 surfaced after exfiltration.
        try:
            providers.assert_base_url_allowed(provider, base_url)
        except providers.BaseUrlNotAllowed as exc:
            return Response(
                # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
                {"detail": str(exc), "code": "base_url_not_allowed"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        provider_handler = cast("type[TaskLinkProvider]", provider_cls)
        result = provider_handler.verify_token(secret, base_url=base_url or None)
        if not result.ok:
            return Response(
                {
                    "detail": _VERIFY_FAILURE_DETAIL.get(
                        result.reason,
                        f"Could not verify the credential with {provider}.",
                    ),
                    "code": "provider_verification_failed",
                    "reason": result.reason,
                },
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        IntegrationCredential.upsert(
            user=request.user,
            provider=provider,
            secret=secret,
            base_url=base_url,
            expires_at=serializer.validated_data.get("expires_at"),
        )
        # Re-render the summary list so the client doesn't need a second
        # request to refresh after a connect / rotate.
        queryset = list(self.get_queryset())
        payload = serialize_credential_summaries(request.user, queryset)
        return Response(
            CredentialSummarySerializer(payload, many=True).data,
            status=status.HTTP_200_OK,
        )

    @extend_schema(responses={204: None})
    def destroy(self, request: Request, provider: str | None = None) -> Response:
        """Revoke (delete) the credential for ``provider``.

        Returns 204 even if no row exists — DELETE is idempotent. Clients
        polling the list after a revoke see ``exists=False`` either way.
        """
        if provider is None or TASK_LINK_PROVIDERS.get(provider) is None:
            return Response(
                {"detail": f"Unknown provider {provider!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # filter().delete() rather than get()+delete() so DELETE on a
        # never-connected provider is a 204 no-op rather than a 404.
        self.get_queryset().filter(provider=provider).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(responses={200: CredentialSummarySerializer})
    def retrieve(self, request: Request, provider: str | None = None) -> Response:
        """Return the single-provider summary row.

        Convenience endpoint for the deep-link case (``#github`` anchor on
        the page) when the client wants a single row's freshness rather
        than the full list.
        """
        if provider is None or TASK_LINK_PROVIDERS.get(provider) is None:
            return Response(
                {"detail": f"Unknown provider {provider!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        queryset = list(self.get_queryset().filter(provider=provider))
        payload = serialize_credential_summaries(request.user, queryset)
        match = next((row for row in payload if row["provider"] == provider), None)
        if match is None:  # pragma: no cover — provider validated above
            raise Http404
        return Response(CredentialSummarySerializer(match).data)


@extend_schema(tags=["tasks"])
class TaskLinkViewSet(
    ProjectScopedViewSet,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[TaskLink],
):
    """Git/PM links on a task (ADR-0049 §3, #637; redesign #970).

    Routes (relative to ``/projects/{project_pk}/tasks/{task_pk}/``):
        GET    links/
        POST   links/         (body ``{url, custom_title?, labels?}``; provider detected)
        GET    links/{pk}/
        PATCH  links/{pk}/             (edit custom_title / labels / url / display_order)
        DELETE links/{pk}/             (soft-delete)
        POST   links/{pk}/refresh/     (synchronous, 5s; refresh cached status)

    Permissions: create/update/destroy follow task-edit (Member+, ``IsProjectMemberWrite``);
    list/retrieve/refresh follow task-read (Viewer+, ``IsProjectMember``). The
    queryset is the IDOR boundary — it scopes to the caller's project membership
    and the task in the URL, so a link id from another project is a 404.
    """

    serializer_class = TaskLinkSerializer
    # A task carries a handful of links — return the bare array (matching the
    # client contract and the credentials viewset) rather than a paged envelope.
    pagination_class = None
    # PATCH-only edits (custom_title/labels/url). A full PUT replace of the
    # server-owned status/provider/title fields is meaningless, so drop it.
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self) -> QuerySet[TaskLink]:
        """Scope to the caller's project membership + the task in the URL.

        Explicit membership check (rather than ``ProjectScopedViewSet``'s
        ``project``/``predecessor`` auto-filter) because ``TaskLink`` reaches
        the project via ``task__project`` — the same pattern as
        ``TaskAttachmentViewSet``.
        """
        user = self.request.user
        if not user.is_authenticated:
            return TaskLink.objects.none()
        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        if not ProjectMembership.objects.filter(
            user=user, project_id=project_pk, is_deleted=False
        ).exists():
            return TaskLink.objects.none()
        return TaskLink.objects.filter(
            task__project_id=project_pk,
            task_id=task_pk,
            is_deleted=False,
        ).select_related("task")

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def get_throttles(self) -> list[BaseThrottle]:
        """Rate-limit only the refresh action — it makes an outbound fetch (#571).

        The cloud-file unfurl is an anonymous outbound GET, so refresh is a
        potential egress amplifier; the per-user throttle caps the call rate on
        top of the SSRF guard. CRUD reads/writes touch only the DB and stay
        un-throttled.
        """
        if self.action == "refresh":
            from .throttles import TaskLinkRefreshThrottle

            return [TaskLinkRefreshThrottle()]
        return super().get_throttles()

    def _get_task(self) -> Task:
        return get_object_or_404(
            Task,
            pk=self.kwargs["task_pk"],
            project_id=self.kwargs["project_pk"],
            is_deleted=False,
        )

    def perform_create(self, serializer: BaseSerializer[TaskLink]) -> None:
        """Create a link, resolving its provider server-side from the URL.

        ``provider`` is never trusted from the client — it is resolved against
        the SaaS hosts and the caller's connected self-hosted ``base_url`` hosts.
        Status starts ``unknown`` (no fetch on add, per ADR-0049 §3).
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        task = self._get_task()
        self.check_object_permissions(self.request, task)
        url = serializer.validated_data["url"]
        provider = providers.resolve_provider_key(url, user=self.request.user)
        instance = serializer.save(task=task, provider=provider)
        link_id = str(instance.pk)
        task_id = str(task.pk)
        project_id = str(task.project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id, "task_link_created", {"id": link_id, "task_id": task_id}
            )
        )

    def perform_update(self, serializer: BaseSerializer[TaskLink]) -> None:
        """Edit a link's user fields (custom_title / labels / url) (#970).

        If the ``url`` itself changes the provider is re-resolved server-side
        (same rule as create — never trusted from the client); ``status`` /
        ``title`` / ``fetched_at`` are left untouched here and only move on an
        explicit refresh. Broadcasts ``task_link_updated`` on commit so other
        board viewers see the edited title/labels live.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        update_kwargs: dict[str, object] = {}
        if "url" in serializer.validated_data:
            update_kwargs["provider"] = providers.resolve_provider_key(
                serializer.validated_data["url"], user=self.request.user
            )
        link = serializer.save(**update_kwargs)
        link_id = str(link.pk)
        task_id = str(link.task_id)
        project_id = str(link.task.project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id, "task_link_updated", {"id": link_id, "task_id": task_id}
            )
        )

    def perform_destroy(self, instance: TaskLink) -> None:
        """Soft-delete so the removal reaches mobile as a sync tombstone."""
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance.soft_delete()
        link_id = str(instance.pk)
        # instance.task is select_related-loaded by get_queryset, so .pk is free
        # and avoids the django-stubs task_id descriptor gap.
        task_id = str(instance.task.pk)
        project_id = str(instance.task.project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id, "task_link_deleted", {"id": link_id, "task_id": task_id}
            )
        )

    @extend_schema(
        request=None,
        responses={200: TaskLinkSerializer, 422: TaskLinkCredentialRequiredSerializer},
    )
    @action(detail=True, methods=["post"])
    def refresh(
        self,
        request: Request,
        project_pk: str | None = None,
        task_pk: str | None = None,
        pk: str | None = None,
    ) -> Response:
        """Refresh the cached status/title from the provider (synchronous, 5s).

        Read-permission action (a Viewer can refresh). If the provider needs a
        PAT and the caller has not connected one, returns 422 ``credential_required``
        so the UI can prompt a connect rather than silently leaving the link
        ``unknown``. Transport/parse failures degrade the status to ``unknown``
        — ``fetch_metadata`` does not raise for an unreachable provider.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        user = request.user
        if not user.is_authenticated:
            return Response(status=status.HTTP_403_FORBIDDEN)

        link = self.get_object()
        handler_cls = TASK_LINK_PROVIDERS.get(link.provider)
        if handler_cls is None:
            # Provider un-registered (Enterprise downgraded / plugin removed) —
            # nothing to fetch; return the row unchanged rather than 500ing.
            return Response(TaskLinkSerializer(link).data)

        requires_credential = getattr(handler_cls, "requires_credential", True)
        credential = IntegrationCredential.objects.filter(user=user, provider=link.provider).first()
        if requires_credential and credential is None:
            return Response(
                {
                    "detail": f"Connect your {link.provider} account to refresh this link.",
                    "code": "credential_required",
                    "provider": link.provider,
                    "requires_credential": True,
                },
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        handler = cast("type[TaskLinkProvider]", handler_cls)()
        metadata = handler.fetch_metadata(link.url, credential)
        link.status = metadata.status
        if metadata.title:
            link.title = metadata.title
        # Cloud-file preview cache (#571, ADR-0163). A file provider returns these;
        # git/generic providers leave them None and the row's empty defaults stand.
        # Coalesce None → "" so the column type (CharField/URLField) is satisfied
        # and a provider that returns no preview clears any stale one.
        link.description = metadata.description or ""
        link.thumbnail_url = metadata.thumbnail_url or ""
        link.preview_type = metadata.preview_type or ""
        link.fetched_at = timezone.now()
        # VersionedModel.save() bumps server_version atomically; we pass the
        # changed fields only and let it handle the version bump + sync delta.
        link.save(
            update_fields=[
                "status",
                "title",
                "description",
                "thumbnail_url",
                "preview_type",
                "fetched_at",
            ]
        )

        if credential is not None:
            credential.last_used_at = timezone.now()
            credential.save(update_fields=["last_used_at"])

        link_id = str(link.pk)
        task_id = str(link.task_id)
        project_id = str(link.task.project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id, "task_link_updated", {"id": link_id, "task_id": task_id}
            )
        )
        return Response(TaskLinkSerializer(link).data)


def _git_webhook_url(request: Request, project_pk: Any) -> str:
    """Absolute URL of a project's inbound Git-webhook receiver (admin pastes this)."""
    from django.urls import reverse

    return request.build_absolute_uri(
        reverse("git-webhook", kwargs={"project_pk": str(project_pk)})
    )


@extend_schema(tags=["integrations"])
class GitWebhookIngestView(IdempotencyMixin, APIView):
    """Inbound Git-event receiver — ``POST .../{project_pk}/git-webhook/`` (#329, ADR-0158).

    The OSS Git-event board-card auto-move receiver. **The signature is the gate** —
    this endpoint is unauthenticated-by-session (``AllowAny``); a GitHub
    ``X-Hub-Signature-256`` HMAC or a GitLab ``X-Gitlab-Token`` over the project's
    secret is what authorizes the call. A bad/missing signature is a hard 401, and
    a project without enabled automation is a 404 so the endpoint never reveals
    which projects have automation configured.

    OSS boundary (ADR-0097 carve-out, mirroring ADR-0148): a single project-scoped,
    off-by-default, one-way Git→card receiver. No org connector, no OAuth, no
    bidirectional sync, no conflict resolution, no reconciliation loop. The general
    multi-provider bidirectional Integration Hub remains Enterprise.
    """

    from .throttles import GitWebhookThrottle

    # Exempt from the HTTP idempotency model: an inbound webhook carries no JWT user
    # to key the Idempotency-Key store on. Replay safety comes from two purpose-built
    # layers instead — the Redis SET NX EX delivery claim and the forward-only status
    # guard (a redelivered move is a no-op even if Redis is unavailable).
    idempotency_exempt = True
    authentication_classes: list[type] = []
    permission_classes = [AllowAny]
    throttle_classes = [GitWebhookThrottle]

    def post(self, request: Request, project_pk: str) -> Response:
        from .throttles import claim_webhook_delivery

        # Read the raw body BEFORE touching request.data — the HMAC must be checked
        # against the exact bytes the provider signed, and accessing request.data
        # consumes the stream.
        raw_body = request.body

        # 404 (not 401) when there is no enabled automation: do not leak which
        # projects have it configured. Scope out soft-deleted projects too.
        automation = (
            BoardAutomation.objects.filter(
                project_id=project_pk,
                enabled=True,
                project__is_deleted=False,
            )
            .select_related("project")
            .first()
        )
        if automation is None or not automation.has_secret:
            raise Http404

        provider = git_webhook_auth.detect_provider(request.headers)
        if provider is None:
            raise Http404

        try:
            secret = decrypt_secret(automation.secret_ciphertext)
        except CredentialEncryptionError:
            # Secret unreadable (key rotated without re-encrypt) → cannot verify.
            return Response(
                {"detail": "Signature verification unavailable."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        try:
            git_webhook_auth.verify_signature(provider, secret, raw_body, request.headers)
        except git_webhook_auth.WebhookSignatureError:
            return Response({"detail": "Invalid signature."}, status=status.HTTP_401_UNAUTHORIZED)

        payload = request.data
        if not isinstance(payload, dict):
            return Response(
                {"detail": "Malformed webhook payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        envelope = git_webhook_auth.parse_envelope(provider, request.headers, payload)
        if envelope.event is None:
            # A configured-but-irrelevant event (push, comment, draft, close). Not an
            # error — return 2xx so the provider does not retry.
            return Response(
                {"matched": False, "moved": False, "ignored": envelope.raw_event_name},
                status=status.HTTP_200_OK,
            )

        # Idempotency: a provider redelivery of the same event is a no-op. The
        # forward-only guard in the service is a second, Redis-independent layer.
        if not claim_webhook_delivery(project_pk, envelope.delivery_key):
            return Response(
                {"matched": False, "moved": False, "reason": "duplicate"},
                status=status.HTTP_200_OK,
            )

        result = apply_git_event_to_card(automation, provider, envelope.event, envelope.pr_url)
        return Response(
            {
                "matched": result.matched,
                "moved": result.moved,
                "task": result.task_id,
                "from": result.from_status,
                "to": result.to_status,
                "reason": result.reason,
            },
            status=status.HTTP_200_OK,
        )


@extend_schema(tags=["integrations"])
class GitAutomationConfigView(IdempotencyMixin, APIView):
    """``GET|PUT /api/v1/integrations/projects/{project_pk}/git-automation/`` — config (#329).

    Project-admin only (Owner/Admin). Reads/sets the off-by-default toggle and
    surfaces the webhook URL and whether a secret is set. The secret itself is
    minted/rotated through :class:`GitAutomationRotateSecretView` and returned once.
    """

    # The PUT sets ``enabled`` to an explicit value on the per-project singleton, so a
    # replay converges to the same state (naturally idempotent — no replayable resource).
    idempotency_exempt = True
    permission_classes = [IsAuthenticated, IsProjectAdmin]
    # Reveals whether a webhook secret is set / lets an admin flip the toggle; scope it
    # under the shared credential bucket (#1551) so config-probing is rate-bounded.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "credential_rotate"

    def _config_payload(self, request: Request, automation: BoardAutomation) -> dict[str, Any]:
        return {
            "enabled": automation.enabled,
            "secret_set": automation.has_secret,
            "webhook_url": _git_webhook_url(request, automation.project_id),
            "configured_by": automation.configured_by_id,
            "secret_set_at": automation.secret_set_at,
            "updated_at": automation.updated_at,
        }

    def _get_or_init(self, project_pk: str) -> BoardAutomation:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        automation, _ = BoardAutomation.objects.get_or_create(project=project)
        return automation

    def get(self, request: Request, project_pk: str) -> Response:
        automation = self._get_or_init(project_pk)
        data = GitAutomationConfigSerializer(self._config_payload(request, automation)).data
        return Response(data)

    def put(self, request: Request, project_pk: str) -> Response:
        serializer = GitAutomationUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        automation = self._get_or_init(project_pk)
        automation.enabled = serializer.validated_data["enabled"]
        # request.user is a real User here (IsAuthenticated gates this view); the
        # cast narrows away the AnonymousUser arm the field FK does not accept.
        automation.configured_by = cast("Any", request.user)
        automation.save(update_fields=["enabled", "configured_by", "updated_at"])
        data = GitAutomationConfigSerializer(self._config_payload(request, automation)).data
        return Response(data)


@extend_schema(tags=["integrations"])
class GitAutomationRotateSecretView(IdempotencyMixin, APIView):
    """``POST .../git-automation/rotate-secret/`` — mint a new webhook secret (#329).

    Project-admin only. Generates a fresh URL-safe secret, stores it Fernet-encrypted,
    and returns the plaintext **once** in the response — it is never retrievable again
    (the GET endpoint only reports whether a secret is set).
    """

    # Exempt: the secret lives in a single column on the per-project singleton, so a
    # double rotation is last-write-wins — only one secret is ever active and a replay
    # cannot mint a parallel credential. This is a deliberate admin action, not a
    # retry-prone client mutation.
    idempotency_exempt = True
    permission_classes = [IsAuthenticated, IsProjectAdmin]
    # Mints and returns a fresh plaintext webhook secret; scope it under the shared
    # credential bucket (#1551) so secret rotation cannot be hammered.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "credential_rotate"

    def post(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        # 256 bits of entropy, URL-safe so it pastes cleanly into a provider's
        # webhook secret field.
        plaintext = secrets.token_urlsafe(32)
        with transaction.atomic():
            automation, _ = BoardAutomation.objects.get_or_create(project=project)
            automation.set_secret(plaintext)
            automation.configured_by = cast("Any", request.user)
            automation.save(
                update_fields=[
                    "secret_ciphertext",
                    "secret_set_at",
                    "configured_by",
                    "updated_at",
                ]
            )
        return Response(
            {
                "secret": plaintext,
                "webhook_url": _git_webhook_url(request, project.pk),
                "secret_set_at": automation.secret_set_at,
            },
            status=status.HTTP_201_CREATED,
        )
