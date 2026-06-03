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

from typing import TYPE_CHECKING, cast

from django.db import transaction
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectNotArchived,
    ProjectScopedViewSet,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Task

from . import providers
from .models import IntegrationCredential, TaskLink
from .registry import TASK_LINK_PROVIDERS, TaskLinkProvider
from .serializers import (
    CredentialSummarySerializer,
    CredentialUpsertSerializer,
    CredentialVerificationErrorSerializer,
    TaskLinkCredentialRequiredSerializer,
    TaskLinkSerializer,
    serialize_credential_summaries,
)

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request
    from rest_framework.serializers import BaseSerializer


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

    def get_queryset(self) -> QuerySet[IntegrationCredential]:
        """Restrict to the authenticated user's rows only.

        The queryset is the single permission boundary — list, retrieve,
        upsert, and delete all read through it, so cross-user access is
        impossible by construction.
        """
        user = self.request.user
        if not user.is_authenticated:  # pragma: no cover — IsAuthenticated guards
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
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[TaskLink],
):
    """Git/PM links on a task (ADR-0049 §3, #637).

    Routes (relative to ``/projects/{project_pk}/tasks/{task_pk}/``):
        GET    links/
        POST   links/                  (body ``{url}``; provider auto-detected)
        GET    links/{pk}/
        DELETE links/{pk}/             (soft-delete)
        POST   links/{pk}/refresh/     (synchronous, 5s; refresh cached status)

    Permissions: create/destroy follow task-edit (Member+, ``IsProjectMemberWrite``);
    list/retrieve/refresh follow task-read (Viewer+, ``IsProjectMember``). The
    queryset is the IDOR boundary — it scopes to the caller's project membership
    and the task in the URL, so a link id from another project is a 404.
    """

    serializer_class = TaskLinkSerializer
    # A task carries a handful of links — return the bare array (matching the
    # client contract and the credentials viewset) rather than a paged envelope.
    pagination_class = None

    def get_queryset(self) -> QuerySet[TaskLink]:
        """Scope to the caller's project membership + the task in the URL.

        Explicit membership check (rather than ``ProjectScopedViewSet``'s
        ``project``/``predecessor`` auto-filter) because ``TaskLink`` reaches
        the project via ``task__project`` — the same pattern as
        ``TaskAttachmentViewSet``.
        """
        user = self.request.user
        if not user.is_authenticated:  # pragma: no cover — IsAuthenticated guards
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
        if self.action in ("create", "destroy"):
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

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
        if not user.is_authenticated:  # pragma: no cover — IsProjectMember guards
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
        link.fetched_at = timezone.now()
        # VersionedModel.save() bumps server_version atomically; we pass the
        # changed fields only and let it handle the version bump + sync delta.
        link.save(update_fields=["status", "title", "fetched_at"])

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
