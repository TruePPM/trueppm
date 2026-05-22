"""ViewSet for the per-user integration credentials API (ADR-0049 §3).

The viewset exposes only three operations — list, upsert (connect or
rotate), and delete (revoke). Read-of-the-secret is intentionally absent:
the encrypted ciphertext stays server-side; the only client-visible signal
about the secret is whether a row exists.

URL contract:
    GET    /api/v1/me/credentials/
    POST   /api/v1/me/credentials/<provider>/
    DELETE /api/v1/me/credentials/<provider>/

All actions auto-scope to ``request.user`` via the queryset — there is no
``user_id`` URL kwarg to forge.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status, viewsets
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response

from .models import IntegrationCredential
from .registry import TASK_LINK_PROVIDERS
from .serializers import (
    CredentialSummarySerializer,
    CredentialUpsertSerializer,
    serialize_credential_summaries,
)

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request


@extend_schema(tags=["me"])
class IntegrationCredentialViewSet(viewsets.GenericViewSet[IntegrationCredential]):
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
        responses={200: CredentialSummarySerializer(many=True)},
    )
    def create(self, request: Request, provider: str | None = None) -> Response:
        """Connect or rotate the credential for ``provider``.

        ``create`` is a deliberate misnomer here: connect-and-rotate are
        the same upsert. The viewset uses ``create`` so the standard DRF
        action set names the route ``POST /<provider>/`` rather than
        ``POST /<provider>/rotate/``, which is what ADR-0049 §3 spells out.
        """
        if provider is None or TASK_LINK_PROVIDERS.get(provider) is None:
            return Response(
                {"detail": f"Unknown provider {provider!r}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = CredentialUpsertSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        IntegrationCredential.upsert(
            user=request.user,
            provider=provider,
            secret=serializer.validated_data["secret"],
            base_url=serializer.validated_data.get("base_url", ""),
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
