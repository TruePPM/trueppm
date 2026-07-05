"""Self-service password reset endpoints (#765, ADR-0209).

Two unauthenticated (``AllowAny``) endpoints drive the forgot-password flow:

- ``POST /api/v1/auth/password/reset/`` — accepts an email and, if it maps to an
  account, emails a one-time reset link. The response is **identical** whether or
  not the address exists, so it leaks no signal about which emails have accounts
  (no user enumeration). Both branches return ``200`` with the same body.
- ``POST /api/v1/auth/password/reset/confirm/`` — accepts ``uid`` + ``token`` +
  ``new_password``, validates the stateless token, enforces the password policy,
  sets the new password, and revokes every other session the account holds.

Token scheme (ADR-0209): Django's built-in ``default_token_generator``
(``PasswordResetTokenGenerator``) over a URL-safe-base64-encoded user PK — the same
mechanism Django's own ``PasswordResetConfirmView`` uses. The token is a keyed HMAC
that is stateless (no DB row), single-use by construction (it stops validating once
the password hash changes), and expires after ``settings.PASSWORD_RESET_TIMEOUT``
(30 minutes). We deliberately do not invent a bespoke token store.

Both endpoints carry a dedicated ``password_reset`` throttle scope (5/min per IP),
which is the primary defense against enumeration-by-probing and against looping the
request endpoint to email-bomb a victim (ADR-0209).
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.utils.encoding import force_bytes, force_str
from django.utils.html import escape
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

logger = logging.getLogger("trueppm.auth")

User = get_user_model()

# Minimum length surfaced in the UI requirements checklist ("At least 10
# characters"). Enforced server-side here so the client checklist is advisory only
# — the server is the authority (ADR-0209).
_MIN_PASSWORD_LENGTH = 10

# Identical success body for the request endpoint regardless of whether the address
# has an account. Defined once so the two branches cannot drift apart and re-open an
# enumeration signal.
_REQUEST_OK_DETAIL = "If an account exists for that address, a password reset link is on its way."


class PasswordResetRequestSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Request body for the reset-link endpoint: a single email address."""

    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Request body for the confirm endpoint: uid + token + the new password.

    Field-level validation only checks *shape* (non-empty strings). The token
    validity check and the user-dependent password policy run in the view so it can
    return distinct, non-leaking error codes (``invalid_token`` vs
    ``weak_password``) that the frontend maps to different screens.
    """

    uid = serializers.CharField(trim_whitespace=False)
    token = serializers.CharField(trim_whitespace=False)
    # trim_whitespace=False: a trailing/leading space is a legitimate part of a
    # password and must not be silently stripped before hashing.
    new_password = serializers.CharField(write_only=True, trim_whitespace=False)


def enforce_reset_password_policy(new_password: str, user: Any) -> None:
    """Validate ``new_password`` against the reset-flow policy (ADR-0209).

    Aggregates every violation into one ``DjangoValidationError`` so the API can
    return the full list at once (the frontend renders them as an inline checklist),
    rather than surfacing one error per round-trip. Policy:

    1. At least ``_MIN_PASSWORD_LENGTH`` (10) characters.
    2. Contains at least one number OR one symbol (a non-alphanumeric character).
    3. Passes Django's configured ``AUTH_PASSWORD_VALIDATORS`` (common-password,
       numeric-only, and attribute-similarity checks — run with ``user`` so the
       similarity validator can compare against the account's own attributes).
    4. Is not identical to the account's current password ("not a previously used
       password" in the UI — the migration-free interpretation: you cannot reset to
       the password you already have; full N-hash history is a deferred follow-up).

    Raises:
        DjangoValidationError: with a ``messages`` list of all violations found.
    """
    errors: list[str] = []

    if len(new_password) < _MIN_PASSWORD_LENGTH:
        errors.append(f"Password must be at least {_MIN_PASSWORD_LENGTH} characters.")

    if not any(c.isdigit() or not c.isalnum() for c in new_password):
        errors.append("Password must include at least one number or symbol.")

    try:
        validate_password(new_password, user)
    except DjangoValidationError as exc:
        errors.extend(exc.messages)

    # check_password is a constant-time-ish hash comparison; only meaningful when the
    # account already has a usable password (it always does on this flow).
    if user is not None and user.has_usable_password() and user.check_password(new_password):
        errors.append("Your new password must be different from your current password.")

    if errors:
        # De-duplicate while preserving order — the min-length rule and Django's
        # MinimumLengthValidator can both fire for a very short password.
        seen: set[str] = set()
        deduped = [m for m in errors if not (m in seen or seen.add(m))]  # type: ignore[func-returns-value]
        raise DjangoValidationError(deduped)


def _reset_link(uid: str, token: str) -> str:
    """Build the absolute frontend confirm URL, or "" when the base URL is unset.

    Mirrors the invite/notification/export idiom (``workspace/tasks.py``): read
    ``FRONTEND_BASE_URL``, strip a trailing slash, and return "" when it is not
    configured so the email builder can omit the link rather than emit a broken
    relative URL. The path matches the SPA route ``/reset-password/confirm/:uid/:token``.
    """
    base = (getattr(settings, "FRONTEND_BASE_URL", "") or "").rstrip("/")
    if not base:
        return ""
    return f"{base}/reset-password/confirm/{uid}/{token}/"


def _render_password_reset_email(user: Any, reset_url: str) -> tuple[str, str, str]:
    """Render (subject, plain-text body, html body) for the reset email.

    Follows the inline-render idiom used by invites/notifications/exports (no
    templates directory exists in the API). Returns both a plain-text body and an
    HTML alternative so the message is sent multipart. The reset link is included
    only when configured; otherwise the copy tells the user to contact their admin
    (matching how every other email degrades when ``FRONTEND_BASE_URL`` is unset).
    """
    subject = "Reset your TruePPM password"
    greeting_name = user.get_short_name() or user.get_username()

    if reset_url:
        link_line_text = reset_url
        # escape() defends against a display name / URL containing HTML-significant
        # characters; the URL itself is server-built so it is trusted, but escaping
        # is cheap insurance and keeps the HTML well-formed.
        link_line_html = f'<a href="{escape(reset_url)}">Reset your password</a>'
        cta_text = "Click the link below to choose a new password:"
    else:
        link_line_text = "Contact your workspace administrator to reset your password."
        link_line_html = "Contact your workspace administrator to reset your password."
        cta_text = "We could not build a reset link for this deployment."

    text_body = "\n".join(
        [
            f"Hi {greeting_name},",
            "",
            "We received a request to reset the password for your TruePPM account.",
            cta_text,
            "",
            link_line_text,
            "",
            "This link is valid for 30 minutes. For your security, using it will sign "
            "you out of every other device.",
            "",
            "If you did not request a password reset, you can safely ignore this email "
            "— your password will not change.",
        ]
    )

    html_body = "".join(
        [
            f"<p>Hi {escape(greeting_name)},</p>",
            "<p>We received a request to reset the password for your TruePPM account. "
            f"{escape(cta_text)}</p>",
            f"<p>{link_line_html}</p>",
            "<p>This link is valid for <strong>30 minutes</strong>. For your security, "
            "using it will sign you out of every other device.</p>",
            "<p>If you did not request a password reset, you can safely ignore this "
            "email — your password will not change.</p>",
        ]
    )
    return subject, text_body, html_body


def send_password_reset_email(user: Any) -> bool:
    """Generate a reset token for ``user`` and email the link. Best-effort.

    Synchronous by design (ADR-0209 §Durable Execution): the reset token is
    stateless and fully re-requestable, so there is no persisted state to reconcile
    if the send fails — the user simply clicks "Resend". A failed SMTP send is logged
    and swallowed so it never turns into a 500 (which would itself leak that the
    address exists). Returns True on a successful send, False otherwise; callers on
    the request endpoint ignore the result to keep the response identical either way.
    """
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    reset_url = _reset_link(uid, token)

    recipient = getattr(user, "email", "") or ""
    if not recipient:
        return False

    subject, text_body, html_body = _render_password_reset_email(user, reset_url)
    # Route through the workspace SMTP transport (#712, ADR-0211) so BYO-SMTP
    # installs deliver reset mail on the same transport as everything else; a
    # no-op fall back to the global backend when the workspace is unconfigured.
    from trueppm_api.apps.notifications.email_backend import (
        resolve_email_connection,
        resolve_from_email,
        resolve_reply_to,
    )

    msg = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=resolve_from_email(),
        to=[recipient],
        reply_to=resolve_reply_to() or None,
        connection=resolve_email_connection(),
    )
    msg.attach_alternative(html_body, "text/html")
    try:
        msg.send(fail_silently=False)
    except Exception:
        # Best-effort: a lost email has no persisted state to reconcile (the token
        # is stateless and re-requestable). Never re-raise — a 500 here would itself
        # leak that the address exists.
        # No secret logged: the only interpolated value is user.pk (a UUID); the
        # literal merely contains the word "password", which trips the heuristic.
        # nosemgrep: python-logger-credential-disclosure
        logger.warning("password reset email failed for user %s", user.pk, exc_info=True)
        return False
    return True


class PasswordResetRequestView(APIView):
    """Request a password reset link. Always returns 200 (no user enumeration).

    Unauthenticated (``AllowAny``) by design — a user who has forgotten their
    password cannot authenticate. The response body is identical whether or not the
    email maps to an account, so the endpoint reveals nothing about which addresses
    have accounts. The residual timing signal (the exists branch does the extra work
    of generating a token and sending mail) is accepted and bounded by the
    ``password_reset`` throttle (ADR-0209).
    """

    permission_classes = [AllowAny]  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "password_reset"

    @extend_schema(
        summary="Request a password reset link",
        description=(
            "Sends a one-time password reset link to the address if — and only if — "
            "it belongs to an account. The response is identical whether or not the "
            "address exists, so it never reveals which emails have accounts. Rate "
            "limited (5/min per IP)."
        ),
        request=PasswordResetRequestSerializer,
        responses={200: OpenApiResponse(description="Reset link sent if the account exists.")},
        auth=[],
        tags=["auth"],
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]

        # Case-insensitive lookup: emails are stored lower-cased on create (invite
        # accept lower-cases; SSO lower-cases), but match defensively either way.
        # Only ACTIVE accounts with a usable password receive a reset link — an SSO-
        # only account (unusable password) or a deactivated account gets the same
        # silent 200, never a link. ``order_by("pk")`` makes the recipient
        # deterministic (the oldest account) in the pathological case where two
        # active accounts share an email case-insensitively — the stock User model
        # does not enforce email uniqueness.
        user = (
            User.objects.filter(email__iexact=email, is_active=True)
            .exclude(password="")
            .order_by("pk")
            .first()
        )
        if user is not None and user.has_usable_password():
            send_password_reset_email(user)

        return Response({"detail": _REQUEST_OK_DETAIL}, status=status.HTTP_200_OK)


class PasswordResetConfirmView(APIView):
    """Confirm a password reset: validate uid+token, set the password, revoke sessions.

    Unauthenticated (``AllowAny``) — possession of a valid, unexpired token *is* the
    authorization. Returns:

    - ``200`` on success (password changed, all other sessions revoked).
    - ``400 {"code": "invalid_token"}`` for any bad/unknown/expired uid+token — the
      same shape for all three so confirm carries no enumeration signal either. The
      frontend maps this to the "expired link" screen.
    - ``400 {"code": "weak_password", "messages": [...]}`` when the new password
      fails the policy. The frontend renders the messages inline.
    """

    permission_classes = [AllowAny]  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "password_reset"

    @extend_schema(
        summary="Confirm a password reset",
        description=(
            "Validates the uid + token from the reset link and sets the new "
            "password. On success, every other active session for the account is "
            "revoked (all refresh tokens are blacklisted). Returns 400 with "
            "`code: invalid_token` for an invalid or expired link, or `code: "
            "weak_password` with a `messages` list when the password fails policy."
        ),
        request=PasswordResetConfirmSerializer,
        responses={
            200: OpenApiResponse(description="Password reset; other sessions revoked."),
            400: OpenApiResponse(description="Invalid/expired token or weak password."),
        },
        auth=[],
        tags=["auth"],
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        uid = serializer.validated_data["uid"]
        token = serializer.validated_data["token"]
        new_password = serializer.validated_data["new_password"]

        user = self._resolve_user(uid)
        # Constant error for every token-side failure (bad uid, unknown user, wrong
        # or expired token) so the response never distinguishes them — no enumeration.
        if user is None or not default_token_generator.check_token(user, token):
            return Response(
                {
                    "code": "invalid_token",
                    "detail": "This password reset link is invalid or has expired.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            enforce_reset_password_policy(new_password, user)
        except DjangoValidationError as exc:
            return Response(
                {
                    "code": "weak_password",
                    "detail": "Password does not meet the requirements.",
                    "messages": list(exc.messages),
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Revoke every other session (ADR-0209): the confirm request itself is
        # unauthenticated, so this signs the account out of every device where it was
        # logged in. The password save and the session revocation run in one
        # transaction so the account can never end up password-changed-but-sessions-
        # live (or vice versa) — defense in depth that does not rely solely on the
        # global ATOMIC_REQUESTS setting.
        from trueppm_api.apps.access.services import revoke_all_refresh_tokens

        with transaction.atomic():
            # Password already validated above by enforce_reset_password_policy(),
            # which runs django...validate_password(new_password, user) plus the
            # reset-flow policy; set_password is only reached once that passed.
            # nosemgrep: unvalidated-password
            user.set_password(new_password)
            user.save(update_fields=["password"])
            revoke_all_refresh_tokens(user)

        return Response(
            {"detail": "Your password has been reset. Please sign in with your new password."},
            status=status.HTTP_200_OK,
        )

    @staticmethod
    def _resolve_user(uid: str) -> Any | None:
        """Decode the urlsafe-base64 uid to a user, or None on any decode/lookup miss.

        A malformed uid, a uid that decodes to a non-existent PK, or a decode error
        all resolve to None — the caller returns the same ``invalid_token`` response
        for all of them, so a probing attacker cannot tell a bad uid from a valid uid
        with a wrong token.
        """
        try:
            pk = force_str(urlsafe_base64_decode(uid))
        except (TypeError, ValueError, OverflowError, UnicodeDecodeError):
            return None
        try:
            return User.objects.get(pk=pk, is_active=True)
        except (User.DoesNotExist, User.MultipleObjectsReturned, ValueError, TypeError):
            return None
