"""JWT authentication that honors the per-user credential cutoff (#4499)."""

from __future__ import annotations

from typing import Any

from django.utils.translation import gettext_lazy as _
from drf_spectacular.contrib.rest_framework_simplejwt import SimpleJWTScheme
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import Token

from trueppm_api.core.credential_cutoff import credentials_revoked_at, issued_before_cutoff


class CredentialCutoffJWTAuthentication(JWTAuthentication):
    """simplejwt's ``JWTAuthentication`` plus the credential cutoff check.

    Why the authenticator and not a permission class: this is the one chokepoint
    every JWT-authenticated request passes through. A permission added to
    ``DEFAULT_PERMISSION_CLASSES`` is inert on every view that declares its own
    ``permission_classes`` — which is most of them, including the WebSocket-ticket,
    Personal Access Token, project token and share-link mint endpoints the
    stale-token window would otherwise reach.

    A refused token raises ``AuthenticationFailed``, which DRF turns into a 401
    with a ``WWW-Authenticate: Bearer`` challenge — it never falls through to the
    next authenticator or to an anonymous request.

    The user is loaded with ``select_related("profile")`` so the cutoff rides on
    the query the stock authenticator already runs: a LEFT JOIN on the profile's
    unique ``user_id`` index, not a second query per request.
    """

    def get_user(self, validated_token: Token) -> Any:
        """Resolve the token's user, refusing it if it predates the user's cutoff."""
        try:
            user_id = validated_token[api_settings.USER_ID_CLAIM]
        except KeyError as exc:
            raise InvalidToken(
                str(_("Token contained no recognizable user identification"))
            ) from exc

        try:
            user = self.user_model.objects.select_related("profile").get(
                **{api_settings.USER_ID_FIELD: user_id}
            )
        except self.user_model.DoesNotExist as exc:
            raise AuthenticationFailed(_("User not found")) from exc

        if api_settings.CHECK_USER_IS_ACTIVE and not user.is_active:
            raise AuthenticationFailed(_("User is inactive"))

        if issued_before_cutoff(validated_token.get("iat"), credentials_revoked_at(user)):
            # No ``code=``: DRF puts only ``detail`` on the wire for this
            # exception, so a code would be an undocumented, unreachable value.
            raise AuthenticationFailed(_("This session was signed out. Please sign in again."))

        return user


class CredentialCutoffJWTScheme(SimpleJWTScheme):  # type: ignore[no-untyped-call]
    """Keep advertising ``jwtAuth`` for the subclass.

    drf-spectacular's extensions match the exact target class, not subclasses, so
    without this every endpoint would silently drop ``jwtAuth`` from its security
    requirements in the published schema.
    """

    target_class = "trueppm_api.core.authentication.CredentialCutoffJWTAuthentication"
