"""DRF authentication class for project-scoped API tokens (ADR-0068)."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Any

from django.contrib.auth.models import AnonymousUser
from django.utils import timezone
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, get_authorization_header

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import ProjectApiToken


TOKEN_PREFIX = "tppm_"
TOKEN_RAW_HEX_LEN = 64  # SHA-256 hex digest length, also = raw token hex length
TOKEN_TOTAL_LEN = len(TOKEN_PREFIX) + TOKEN_RAW_HEX_LEN  # 69


def sha256_hex(raw: str) -> str:
    """Return the SHA-256 hex digest of the raw token (no salt; 256-bit entropy)."""
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


class ProjectApiTokenAuthentication(BaseAuthentication):
    """Authenticate a request via ``Authorization: Bearer tppm_<64-hex>``.

    On success returns ``(token.created_by, token)`` so DRF sets ``request.user``
    to the token's creator (history rows attribute to a real user) and
    ``request.auth`` to the token itself (the throttle and view use it for the
    project_id and the backfill window).

    On any failure returns a generic 401 with no body detail — prevents
    enumeration of valid token prefixes or revocation states.
    """

    keyword = "Bearer"

    def authenticate(self, request: Request) -> tuple[object, ProjectApiToken] | None:
        # Import here so the module can be imported during Django settings load
        # (the apps registry is not yet ready at import time).
        from trueppm_api.apps.projects.models import ProjectApiToken

        auth = get_authorization_header(request).split()
        if not auth or auth[0].lower() != self.keyword.lower().encode("ascii"):
            return None  # let other authenticators try (JWT, Session)
        if len(auth) == 1:
            raise exceptions.AuthenticationFailed("Invalid token header.")
        if len(auth) > 2:
            raise exceptions.AuthenticationFailed("Invalid token header.")
        try:
            raw_token = auth[1].decode("ascii")
        except UnicodeDecodeError as exc:
            raise exceptions.AuthenticationFailed("Invalid token header.") from exc

        # Cheap structural validation before any DB lookup.  Avoids exposing the
        # DB to malformed input and makes the timing of "wrong prefix" vs
        # "valid prefix, unknown hash" indistinguishable from the client side
        # (both return 401 with no body).
        if len(raw_token) != TOKEN_TOTAL_LEN or not raw_token.startswith(TOKEN_PREFIX):
            raise exceptions.AuthenticationFailed("Invalid token.")

        token_body = raw_token[len(TOKEN_PREFIX) :]
        try:
            int(token_body, 16)  # confirm it parses as hex; rejects arbitrary input
        except ValueError as exc:
            raise exceptions.AuthenticationFailed("Invalid token.") from exc

        token = (
            ProjectApiToken.objects.filter(
                token_hash=sha256_hex(raw_token),
                revoked_at__isnull=True,
                is_deleted=False,
            )
            .select_related("project", "created_by")
            .first()
        )
        if token is None:
            raise exceptions.AuthenticationFailed("Invalid token.")

        # last_used_at is updated in a single UPDATE so we don't perturb the
        # token's server_version or audit_history.  The audit row for the
        # specific use is written by the view (which holds the URL kwargs).
        ProjectApiToken.objects.filter(pk=token.pk).update(last_used_at=timezone.now())

        # request.user is the token creator (or AnonymousUser if the creator was
        # deleted).  django-simple-history reads request.user via
        # HistoricalRecords' middleware and writes it as history_user, so task
        # mutations done via this token attribute back to the human who minted
        # the integration.
        user = token.created_by if token.created_by is not None else AnonymousUser()
        return (user, token)

    def authenticate_header(self, request: Request) -> str:
        return self.keyword


# drf-spectacular's OpenApiAuthenticationExtension registers subclasses via an
# untyped __init_subclass__, which mypy --strict flags as an untyped call on the
# class definition. The registration is the documented extension mechanism.
class ProjectApiTokenScheme(OpenApiAuthenticationExtension):  # type: ignore[no-untyped-call]
    """drf-spectacular security scheme for project-scoped API tokens (#1016).

    Without this, drf-spectacular cannot map ``ProjectApiTokenAuthentication`` to a
    security scheme, so endpoints that override ``authentication_classes`` with it
    (``TaskSyncView``) silently inherit the global ``jwtAuth`` in the schema —
    integrators read the schema, send a JWT, and get 401. Registering the scheme
    here (next to the auth class, imported whenever a view references it) makes the
    schema advertise the correct ``Authorization: Bearer tppm_<64-hex>`` contract.
    """

    target_class = "trueppm_api.apps.projects.authentication.ProjectApiTokenAuthentication"
    name = "projectApiTokenAuth"

    def get_security_definition(self, auto_schema: Any) -> dict[str, Any]:
        return {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "tppm_<64-hex>",
            "description": (
                "Project-scoped API token (ADR-0068). Send as "
                "`Authorization: Bearer tppm_<64-hex>`. Mint one in project settings; "
                "it is scoped to a single project and the task-sync surface."
            ),
        }
