"""Cookie-based JWT auth views (#897).

These views replace the stock simplejwt token endpoints so the *refresh* token
is delivered to the browser in an ``httpOnly`` cookie scoped to the refresh path
instead of in the JSON response body. The access token is still returned in the
JSON body and held in memory by the SPA.

Why httpOnly for the refresh token:
    A refresh token is long-lived and exchangeable for access tokens, so it is
    the high-value credential. Persisting it where JavaScript can read it
    (localStorage / a JS-visible cookie) means any XSS that runs in the SPA can
    exfiltrate it and impersonate the user past the lifetime of any single
    access token. An ``httpOnly`` cookie is unreadable from JavaScript, so an
    XSS payload can ride the current session but cannot steal the long-lived
    credential. The short-lived access token stays in memory (not localStorage)
    so it dies with the tab.

CSRF posture:
    The refresh cookie uses ``SameSite=Strict`` and is ``Path``-scoped to the
    refresh endpoint only. ``SameSite=Strict`` means the browser never attaches
    the cookie to a cross-site request, so a forged request from an attacker's
    origin cannot trigger a refresh on the victim's behalf. The refresh endpoint
    is otherwise unauthenticated-by-cookie (it reads the refresh token solely
    from this cookie), and a successful refresh only mints a new short-lived
    access token returned in the response body — which a cross-site attacker
    cannot read (CORS). There is therefore no additional CSRF token required on
    the refresh path. Login and logout are likewise safe: login carries no
    ambient credential, and logout is idempotent (clearing a cookie + best-effort
    blacklist) with no cross-site state-change value.
"""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import logging
from datetime import timedelta
from typing import Any, TypeGuard, cast

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import AuthenticationFailed, Throttled
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from trueppm_api.core.throttling import LoginAccountRateThrottle

# Auth-domain logger. Failed-login attempts are emitted here as a structured
# WARNING so self-hosting operators can alarm on brute-force / credential-stuffing
# spikes (e.g. ship trueppm.auth to a SIEM and alert on a burst). Reuses the same
# named logger as the password-reset flow so all auth events land on one channel.
logger = logging.getLogger("trueppm.auth")

#: The active user model. Bound once at module scope so the login path's
#: email resolution and its timing-equalizing dummy hash both go through the
#: same class the authentication backend uses.
User = get_user_model()


def _client_ip(request: Request) -> str:
    """Best-effort client IP for the audit event.

    Prefers the left-most ``X-Forwarded-For`` hop when present (deployments sit
    behind an ingress), falling back to ``REMOTE_ADDR``. This value is only used
    for an operator-facing log line, never for a security decision, so a spoofable
    header is acceptable here — the per-account throttle does the enforcement.

    **The result is parsed as an IP address and replaced with ``"invalid"`` if it is
    not one** (#3552). Spoofing the *value* is accepted; forging the *shape* is not.
    Both auth lines are space-delimited ``key=value``, and this field is caller-supplied
    and sits before another field, so an unvalidated value containing spaces and ``=``
    lets a caller inject extra pairs into the record:

        X-Forwarded-For: 1.2.3.4 user_id=1 method=password

    A last-wins logfmt/Splunk-kv extractor then attributes the session to a different
    account. Raw CR/LF cannot reach here (the HTTP parser rejects them) so a wholly
    forged line was never possible, but intra-line field forgery was. Validating here
    fixes ``auth.login_failed`` — reachable *without* credentials, and so the worse of
    the two — at the same time.
    """
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    candidate = (
        str(forwarded).split(",")[0].strip()
        if forwarded
        else str(request.META.get("REMOTE_ADDR", "") or "").strip()
    )
    if not candidate:
        return "unknown"
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return "invalid"


def _login_body(request_data: Any) -> dict[str, Any]:
    """Return the login body as a dict, or an empty one.

    A non-object JSON body (list/str/scalar) leaves ``request.data`` without a
    ``.get``; every helper here goes through this guard so no path can turn a
    malformed login into a 500 (#2126). Returning ``{}`` rather than ``None`` keeps
    each caller's own logic single-branch.
    """
    return request_data if isinstance(request_data, dict) else {}


def _submitted_identifier(request_data: Any) -> str | None:
    """Return the trimmed ``username`` field from a login body, or None.

    A non-string value is refused rather than coerced — ``str(...)`` on a dict or
    list would mint an identifier nobody typed.
    """
    raw = _login_body(request_data).get("username")
    return raw.strip() if isinstance(raw, str) else None


def _looks_like_email(identifier: str | None) -> TypeGuard[str]:
    """True when ``identifier`` is worth retrying as an email address.

    Deliberately just an ``@`` test rather than validation. Two things it buys, and
    the second is the load-bearing one:

    * the ordinary username path never pays for the extra query, because a
      username without an ``@`` never reaches the fallback at all; and
    * the empty string can never reach ``email__iexact``. ``User.email`` is
      ``blank=True`` on Django's default model — SSO- and admin-created accounts
      routinely have ``""`` — so an ``email__iexact=""`` lookup would match every
      account that has no email at all, and on an install with exactly one such
      account it would hand an attacker a working identifier for it.
    """
    return identifier is not None and "@" in identifier


def _resolve_email_identifier(identifier: str) -> str | None:
    """Resolve an email address to the username of the one account holding it.

    Returns ``None`` whenever the caller must NOT be retried under a different
    identifier. Django's ``User.email`` carries no uniqueness constraint, so the
    ambiguous case is the dangerous one and it fails closed — mirroring the
    ``email__iexact`` branch in ``apps.sso.services.resolve_user``, which refuses
    an ambiguous match for the same reason: silently picking one of two accounts
    signs the caller in as an account they did not name.
    """
    matches = list(
        User.objects.filter(email__iexact=identifier)
        .order_by("pk")
        .values_list("username", flat=True)[:2]
    )
    if len(matches) != 1:
        # 0 → nothing to retry. 2+ → ambiguous, fail closed (see docstring).
        return None
    username = str(matches[0])
    if username.lower() == identifier.lower():
        # The account's username IS this string, so the first attempt already tried
        # it against this exact account and it failed. Retrying would spend a second
        # password comparison to reach the identical answer.
        return None
    return username


def _burn_equivalent_password_hash(request_data: Any) -> None:
    """Spend one password-hash's worth of work on the email-fallback miss path.

    Without this the endpoint is an email-existence oracle. ``ModelBackend`` already
    equalizes its own username miss (it runs ``UserModel().set_password(password)``
    so a nonexistent user costs the same as a wrong password), but the email
    fallback adds a *second* real comparison on the hit path only — so "this email
    has an account" would measure as roughly twice the hash time of "it does not",
    and the dominant term in a login response is the hasher, not the query.

    Called on every ``@``-shaped identifier whose fallback did not run, so all
    ``@``-shaped failures cost two hashes and are indistinguishable from each other.
    This equalizes the dominant term, not every nanosecond — the extra ``email__iexact``
    query on some paths is ~1ms against ~100ms of PBKDF2, well under the noise floor
    of a network round trip. The cost is that a failed ``@``-shaped login burns two
    hashes instead of one; both login throttles bound that, and it is the same trade
    Django itself already makes for the username miss.
    """
    password = _login_body(request_data).get("password")
    # The User() here is disposable — never saved, discarded on return — so there is
    # no unvalidated credential being persisted; this mirrors ModelBackend's own
    # UserModel().set_password(password) timing-equalization decoy.
    # nosemgrep: unvalidated-password
    User().set_password(password if isinstance(password, str) else "")


def _emit_login_failure_event(request: Request, canonical_identifier: str | None = None) -> None:
    """Emit an auth-failure audit event for a rejected login (#1717).

    The attempted username is hashed (never logged in the clear) so the event is
    correlatable across attempts — an operator can see that one account is being
    hammered from many IPs — without writing raw credentials/emails into logs.

    ``canonical_identifier`` is the account's own username, passed when the attempt
    arrived as an email and the view resolved it (#3468). Hashing the *resolved*
    identifier is what keeps that correlation working: without it one account
    produces two distinct hashes depending on which of its identifiers was typed,
    and an operator alarming on "one account, many IPs" undercounts by exactly the
    split.
    """
    # A non-object JSON body (list/str/scalar) leaves ``request.data`` without a
    # ``.get``; guard on the dict shape so audit emission can never turn a rejected
    # login into a 500 (#2126). A non-object body simply has no username → "unknown".
    raw_username = canonical_identifier or _submitted_identifier(request.data)
    username_hash = (
        hashlib.sha256(str(raw_username).strip().lower().encode("utf-8")).hexdigest()
        if raw_username
        else "unknown"
    )
    logger.warning(
        "auth.login_failed username_hash=%s client_ip=%s",
        username_hash,
        _client_ip(request),
    )


def emit_login_success(request: Request, *, user: Any, method: str, remember: bool) -> None:
    """Emit the structured login-success line for a session that was actually minted.

    The counterpart to :func:`_emit_login_failure_event` (#3552, ADR-1120). Both land on
    ``trueppm.auth`` — including the SSO callback's success, which imports this rather
    than logging to ``trueppm.sso`` beside the SSO *refusals*. Correlating "who got in"
    must not require knowing which door they used.

    **Call this last, once the session exists — not when credentials validate.** The two
    are different moments: :class:`CookieTokenObtainPairView` runs the enterprise
    ``local_login_allowed`` seam *after* validation, and that seam can still return a 403
    with no cookie. A line emitted at the validation point therefore reports a success
    for a request that was refused, which inverts exactly the signal an operator alarms
    on. The same applies to the SSO callback: after the refresh cookie is set, not after
    ``resolve_user`` returns.

    ``INFO``, not ``WARNING`` — a successful login is not an anomaly, and putting it at
    ``WARNING`` beside ``auth.login_failed`` would poison the alerting rule that line
    exists to feed. ``DJANGO_LOG_LEVEL`` defaults to ``INFO``, so the line is visible in a
    default production deploy; ``settings/dev.py`` replaces ``LOGGING`` with a root
    handler at ``WARNING``, so it is not visible under dev settings (which is why tests
    raise the level explicitly).

    Fields go in the message rather than in ``extra=`` because the dev console formatter
    renders only ``%(message)s``: an ``extra``-only field would exist in the production
    JSON handler and nowhere else, and a record whose content depends on the deployment is
    worse than one that is uniformly greppable.

    Args:
        request: The request that established the session (read only for the client IP).
        user: The authenticated user. Only ``pk`` is logged — never the email or
            username, matching ``_emit_login_failure_event``, which hashes the submitted
            identifier rather than writing it in the clear.
        method: ``"password"`` or ``"sso:<provider-slug>"``.
        remember: Whether the session opted into browser-persistent "remember me". SSO
            logins are always ``False`` (an IdP redirect carries no such choice).
    """
    logger.info(
        "auth.login_succeeded user_id=%s method=%s client_ip=%s remember=%s",
        getattr(user, "pk", None),
        method,
        _client_ip(request),
        remember,
    )


def _set_refresh_cookie(
    response: Response, refresh_token: str, *, persistent_seconds: int | None
) -> None:
    """Attach the refresh token to ``response`` as a hardened httpOnly cookie.

    Cookie attributes are driven by settings so a non-HTTPS local dev server can
    still complete the flow (``AUTH_REFRESH_COOKIE_SECURE=False``) while
    production defaults to ``Secure``. The cookie is ``Path``-scoped to
    ``/api/v1/auth/`` so it is never sent on ordinary API calls — only the auth
    endpoints that must read it (refresh and logout) receive it. Scoping it to the
    refresh endpoint alone silently broke logout revocation (#2999).

    ``persistent_seconds`` controls browser *persistence* (#2246): an int sets a
    ``Max-Age`` so the cookie survives browser close ("remember me"); ``None``
    emits no ``Max-Age``/``Expires`` → a **session cookie** that the browser drops
    on close (the not-remembered / shared-machine default). This is independent of
    the token's own ``exp`` (the real credential bound), which the caller sets via
    :func:`_apply_remember`.
    """
    response.set_cookie(
        key=settings.AUTH_REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=persistent_seconds,
        httponly=True,
        secure=settings.AUTH_REFRESH_COOKIE_SECURE,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
    )


def _cookie_seconds(remember: bool) -> int | None:
    """Cookie ``Max-Age`` for a remember choice: persistent 30d, or session (None)."""
    if remember:
        return int(settings.REFRESH_TOKEN_REMEMBER_LIFETIME.total_seconds())
    return None


def _record_outstanding(refresh: RefreshToken) -> None:
    """Upsert the ``OutstandingToken`` bookkeeping row for ``refresh``.

    This row is what makes a refresh token *revocable*. ``revoke_all_refresh_tokens``
    (the "sign out every device" primitive behind password reset and off-boarding)
    iterates ``OutstandingToken`` and blacklists each row, so a live token with no
    row cannot be revoked by any server-side action.

    Two distinct cases, which is why this is an upsert rather than an update (#2999):

    * **Login** — ``RefreshToken.for_user`` already wrote a row, but its
      ``expires_at`` was copied from the token's ``exp`` *at creation*: the 7-day
      class default, before :func:`_apply_remember` overrides it. ``expires_at``
      drives the nightly ``flushexpiredtokens`` cleanup and ``BlacklistedToken``
      cascades on the ``OutstandingToken``, so a row left at 7 days for a 30-day
      token would have its revocation record flushed on day 7 while the JWT stayed
      valid to day 30 → **replayable between day 7 and day 30**.
    * **Rotation** — ``refresh.set_jti()`` mints a new jti and simplejwt records
      nothing for it (``outstand()`` is called nowhere in simplejwt's rotation
      path). Before #2999 the row was therefore missing for precisely the token
      that was live, so ``revoke_all_refresh_tokens`` walked a set of
      already-blacklisted rows, returned a plausible non-zero count, and left the
      real session usable. A password reset did not evict an attacker.

    ``created_at`` is only written on insert, so a re-issued row keeps its original
    mint time. No-op when the blacklist app is absent (lean deploy degrades to
    TTL-only expiry) or when the token carries no jti/user claim.
    """
    if "rest_framework_simplejwt.token_blacklist" not in settings.INSTALLED_APPS:
        return
    from rest_framework_simplejwt.settings import api_settings
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
    from rest_framework_simplejwt.utils import datetime_from_epoch

    jti = refresh.payload.get(api_settings.JTI_CLAIM)
    user_id = refresh.payload.get(api_settings.USER_ID_CLAIM)
    if jti is None or user_id is None:
        return

    OutstandingToken.objects.update_or_create(
        jti=jti,
        create_defaults={
            "user_id": user_id,
            "token": str(refresh),
            "created_at": timezone.now(),
            "expires_at": datetime_from_epoch(refresh["exp"]),
        },
        defaults={
            "user_id": user_id,
            "token": str(refresh),
            "expires_at": datetime_from_epoch(refresh["exp"]),
        },
    )


def _token_subject_is_active(refresh: RefreshToken) -> bool:
    """Whether the account a refresh token was minted for is still usable.

    Returns ``False`` for a missing claim, an account that no longer exists, and a
    deactivated one. The wording of the caller's rejection is deliberately the same
    "invalid or expired" string simplejwt uses for a bad token: a distinct message
    would tell an attacker holding a stolen token that the account exists and was
    disabled, which is an enumeration signal on the one endpoint that is reachable
    without authentication.
    """
    from rest_framework_simplejwt.settings import api_settings

    user_id = refresh.payload.get(api_settings.USER_ID_CLAIM)
    if user_id is None:
        return False

    user_model = get_user_model()
    try:
        return user_model.objects.filter(
            **{api_settings.USER_ID_FIELD: user_id, "is_active": True}
        ).exists()
    except (DjangoValidationError, ValueError, TypeError):
        # A claim of the wrong type for the pk column (a string where an int is
        # expected) makes Django raise at query build. DRF does not convert
        # Django's ValidationError, so letting it escape turns a bad token into a
        # 500 on an unauthenticated endpoint. Treat an unusable claim as "not a
        # valid subject" — the same answer as a claim that matches nothing.
        return False


def _apply_remember(refresh: RefreshToken, *, remember: bool) -> None:
    """Stamp the ``remember`` claim + matching ``exp`` on a refresh token (#2246).

    The choice is carried as a boolean claim *on the token itself* so it survives
    encode/decode and is inherited automatically across rotation (the stateless
    refresh endpoint has no ``remember_me`` in its request). ``set_exp(lifetime=)``
    overrides simplejwt's class default, baking the real credential lifetime — 30
    days for remember, 12 hours (sliding via rotation) for a session login.
    """
    lifetime = (
        settings.REFRESH_TOKEN_REMEMBER_LIFETIME
        if remember
        else settings.REFRESH_TOKEN_SESSION_LIFETIME
    )
    refresh["remember"] = remember
    refresh.set_exp(lifetime=lifetime)


def _clear_refresh_cookie(response: Response) -> None:
    """Delete the refresh cookie, matching the path/samesite it was set with.

    ``delete_cookie`` must be called with the same ``path`` (and ``samesite``)
    the cookie was set with, or the browser keeps the original cookie.
    """
    response.delete_cookie(
        key=settings.AUTH_REFRESH_COOKIE_NAME,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
    )


class _LoginRequestSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Login request body: credentials + the optional ``remember_me`` flag (#2246).

    ``username`` accepts either identifier (#3468) — the field keeps its name for
    wire compatibility with every existing client and with simplejwt's serializer.

    Declared for the OpenAPI schema only — the view validates credentials via
    simplejwt's ``TokenObtainPairSerializer`` and reads ``remember_me`` from the
    body separately, so this serializer documents the request shape (so API-first
    consumers see ``remember_me``) without being used to validate.
    """

    username = serializers.CharField(
        help_text=(
            "The account's username, or the email address on the account (#3468). "
            "The username is matched first; the email is tried only if that fails, "
            "and only when exactly one account carries it — an email shared by two "
            "accounts is refused rather than resolved to either."
        )
    )
    password = serializers.CharField(write_only=True, style={"input_type": "password"})
    remember_me = serializers.BooleanField(
        required=False,
        default=False,
        help_text=(
            "Keep the session across browser close (~30 days). Omitted or false → a "
            "session-only login: the refresh cookie is dropped on browser close, with "
            "a ~12h idle lifetime. Must be a JSON boolean; non-boolean values are "
            "treated as false."
        ),
    )


class _LoginResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Login response shape: the access token only.

    The refresh token is intentionally absent from the body — it is delivered as
    an httpOnly cookie (#897). Declared explicitly so drf-spectacular does not
    emit simplejwt's default ``TokenObtainPair`` schema, which still claims a
    required ``refresh`` field this view never returns (#997).
    """

    access = serializers.CharField()


class CookieTokenObtainPairView(TokenObtainPairView):
    """JWT login: return the access token in the body, refresh in an httpOnly cookie.

    Throttled with the scoped ``login`` rate (#770) to bound password guessing.
    The refresh token is *removed* from the JSON response body and set as a
    hardened cookie instead, so a successful login response no longer carries the
    long-lived credential anywhere JavaScript can read it (#897).

    Two throttles are STACKED (#1717): the IP-keyed ``login`` scope bounds guesses
    per source address, and ``LoginAccountRateThrottle`` bounds guesses per
    *account* (hashed username) across all source IPs — closing the distributed
    credential-stuffing gap where a rotating IP pool gets the full per-IP allowance
    from every fresh IP. Both must pass for a request to reach authentication.
    """

    # RUF012: throttle_classes is inherited from the simplejwt base; ruff reads
    # this as a fresh mutable default it can't resolve.
    throttle_classes = [ScopedRateThrottle, LoginAccountRateThrottle]  # noqa: RUF012
    throttle_scope = "login"

    @extend_schema(
        summary="Log in and obtain a JWT access token",
        description=(
            "Returns the short-lived **access** token in the JSON body. The "
            "long-lived **refresh** token is set as an httpOnly, Secure, "
            "SameSite=Strict cookie scoped to the refresh endpoint; it is never "
            "present in the response body (#897)."
        ),
        request=_LoginRequestSerializer,
        responses={200: _LoginResponseSerializer},
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = TokenObtainPairSerializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except TokenError as exc:
            raise InvalidToken(exc.args[0]) from exc
        except AuthenticationFailed:
            # Bad credentials (simplejwt raises AuthenticationFailed with code
            # "no_active_account"). Before giving up, retry ONCE with the submitted
            # identifier resolved as an email address (#3468): the sign-in form asks
            # for an email, invited users choose a *username* at accept time, and
            # ModelBackend matches on username only — so a user typing exactly what
            # the label asked for was refused.
            #
            # Ordering is the security property, not a convenience. The username
            # attempt runs FIRST and unchanged, so this can only ever ADD a way in:
            # an existing username keeps working, and an account whose *username* is
            # email-shaped is never shadowed by a different account that happens to
            # carry that string as its *email*.
            #
            # This lives in the view rather than in an AUTHENTICATION_BACKENDS entry
            # on purpose. A backend would widen every ``authenticate()`` caller in the
            # process — the Django admin login among them — and would bypass this
            # view's post-authentication policy seam below.
            identifier = _submitted_identifier(request.data)
            resolved = None
            if _looks_like_email(identifier):
                resolved = _resolve_email_identifier(identifier)
                if resolved is None:
                    _burn_equivalent_password_hash(request.data)
            if resolved is None:
                _emit_login_failure_event(request)
                raise

            # Charge AND enforce the resolved account's own throttle bucket. The
            # per-account throttle keys on the identifier as submitted (it runs before
            # this view), so an attacker alternating username and email would otherwise
            # get two independent buckets against one account and double the guess
            # allowance #1717 exists to bound.
            #
            # Recording alone is not enough, and is the shape that looks finished while
            # being half-broken: the canonical bucket already accumulates every attempt
            # in either form, but if nothing CHECKS it here, an attacker who spends the
            # username budget first arrives at an untouched email bucket and gets a
            # second full allowance. Only the email-first order would be capped. So the
            # refusal happens here, before the second password comparison is spent.
            wait = LoginAccountRateThrottle.consume(resolved)
            if wait is not None:
                _emit_login_failure_event(request, canonical_identifier=resolved)
                raise Throttled(wait=wait) from None

            # Re-validate through the SAME serializer so every downstream step —
            # the enterprise password-login policy seam, remember_me, the refresh
            # cookie, the OutstandingToken row — runs exactly as it does for a
            # username login. A resolution that short-circuited any of them would
            # be a second, weaker login path wearing the first one's name.
            # Build the retry body from the guarded dict, not from ``request.data``:
            # every other field the caller sent (``password``, ``remember_me``) rides
            # through untouched, and only the identifier is rewritten.
            serializer = TokenObtainPairSerializer(
                data={**_login_body(request.data), "username": resolved}
            )
            try:
                serializer.is_valid(raise_exception=True)
            except TokenError as exc:
                raise InvalidToken(exc.args[0]) from exc
            except AuthenticationFailed:
                # Right email, wrong password. Identical 401, identical body, and the
                # same audit line as every other refusal — the caller must not be able
                # to tell "no account with this email" from "wrong password".
                _emit_login_failure_event(request, canonical_identifier=resolved)
                raise

        # Password-login policy seam (ADR-0187 §4). OSS always allows password
        # login (the default returns True); trueppm-enterprise registers a policy
        # that can block local login when an admin enforces org-wide SSO. Imported
        # lazily so this auth path carries no hard dependency on the sso app at
        # module load. The check runs only after a *successful* credential
        # validation, so it never leaks whether an account exists.
        from trueppm_api.apps.sso.extensions import local_login_allowed

        if not local_login_allowed(serializer.user):
            return Response(
                {"detail": "Password sign-in is disabled for this account. Use single sign-on."},
                status=status.HTTP_403_FORBIDDEN,
            )

        # "Remember me" (#2246): a remember_me of JSON `true` opts into a long-lived,
        # browser-persistent session; anything else (unchecked / omitted / non-object
        # body / a non-boolean like the string "false") falls back to the safe session
        # default. We require an actual boolean `is True` rather than bool()-coercing,
        # so a client that sends the *string* "false"/"0" is not silently upgraded to a
        # 30-day persistent credential — the coercion must err toward session-only. The
        # dict guard mirrors _emit_login_failure_event (a non-object body has no .get).
        remember = isinstance(request.data, dict) and request.data.get("remember_me") is True

        data = dict(serializer.validated_data)
        refresh_token = data.pop("refresh", None)

        response = Response(data, status=status.HTTP_200_OK)
        if refresh_token:
            # Reuse the token the serializer already minted (same jti / OutstandingToken
            # row) rather than issuing a second one, then stamp the remember lifetime.
            refresh = RefreshToken(refresh_token)
            _apply_remember(refresh, remember=remember)
            _record_outstanding(refresh)
            _set_refresh_cookie(
                response, str(refresh), persistent_seconds=_cookie_seconds(remember)
            )
        # LAST, deliberately (#3552, ADR-1120): the session now exists. Emitting this
        # where the credentials validated would report a success for a login the
        # ``local_login_allowed`` seam above still refuses with a 403 and no cookie.
        emit_login_success(request, user=serializer.user, method="password", remember=remember)
        return response


class _CookieRefreshResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Response shape for the cookie-based refresh endpoint (access token only)."""

    access = serializers.CharField()


class CookieTokenRefreshView(APIView):
    """JWT refresh that reads the refresh token from the httpOnly cookie.

    The refresh token is never accepted from the request body — it is read only
    from the cookie set at login — so the SPA does not need JavaScript access to
    it. The token is rotated (a new refresh token is minted and re-cookied) when
    ``ROTATE_REFRESH_TOKENS`` is enabled, and the previous token is blacklisted
    when the blacklist app is installed (``BLACKLIST_AFTER_ROTATION``). The new
    access token is returned in the body.
    """

    # The default permission class is IsAuthenticated, but refresh must be
    # callable by a client whose access token has already expired. Authentication
    # here is the possession of a valid refresh cookie, validated below.
    permission_classes: list[Any] = []  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "refresh"

    @extend_schema(
        request=None,
        responses={
            200: _CookieRefreshResponseSerializer,
            401: OpenApiResponse(description="Missing or invalid refresh cookie."),
        },
        summary="Refresh the access token using the httpOnly refresh cookie",
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raw_token = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        if not raw_token:
            return Response(
                {"detail": "No refresh token cookie present."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        try:
            # RefreshToken accepts an encoded token string at runtime; the stub
            # only types the Token object form.
            refresh = RefreshToken(raw_token)  # type: ignore[arg-type]
        except TokenError as exc:
            # False positive: simplejwt's TokenError carries a curated, client-safe
            # reason ("Token is invalid or expired"), never a trace/path/internal.
            return Response(
                {"detail": str(exc)},  # codeql[py/stack-trace-exposure]
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # Defense in depth (#2999): blacklisting is the primary revocation channel,
        # but it only reaches tokens we have a row for. A deactivated account must
        # not be able to mint access tokens regardless — off-boarding sets
        # ``is_active=False`` and every credential derived from the account has to
        # stop working at that moment, not at the refresh token's TTL. The view is
        # deliberately unauthenticated (the access token may already have expired),
        # so this is the only place the account's live state is consulted.
        if not _token_subject_is_active(refresh):
            return Response(
                {"detail": "Token is invalid or expired."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        access_token = str(refresh.access_token)

        rotate = settings.SIMPLE_JWT.get("ROTATE_REFRESH_TOKENS", False)
        response = Response({"access": access_token}, status=status.HTTP_200_OK)

        if rotate:
            # Preserve the "remember me" choice across rotation (#2246): the incoming
            # token's ``remember`` claim decides the rotated token's lifetime and
            # cookie persistence. A missing claim marks a pre-#2246 token — keep the
            # legacy 7-day persistent behavior so those live sessions are never
            # disrupted (they adopt the new model at their next fresh login).
            remember_claim = refresh.payload.get("remember")

            # Blacklist the just-used refresh token before issuing a new one, so a
            # leaked token cannot be replayed once the legitimate client rotates.
            # The token_blacklist app is installed by default (#910); the
            # AttributeError suppression is belt-and-braces for a lean deploy that
            # removes it, in which case rotation degrades to TTL-only expiry.
            if settings.SIMPLE_JWT.get("BLACKLIST_AFTER_ROTATION", False):
                with contextlib.suppress(AttributeError):
                    refresh.blacklist()
            refresh.set_jti()
            if remember_claim is None:
                legacy_lifetime = cast(timedelta, settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"])
                refresh.set_exp(lifetime=legacy_lifetime)
                persistent_seconds: int | None = int(legacy_lifetime.total_seconds())
            else:
                remember = bool(remember_claim)
                _apply_remember(refresh, remember=remember)
                persistent_seconds = _cookie_seconds(remember)
            refresh.set_iat()
            # Record the rotated jti so the new token is revocable (#2999). simplejwt
            # writes an OutstandingToken only in ``for_user`` (login); without this the
            # live token is the one row-less token, and every server-side revocation
            # path silently misses it.
            _record_outstanding(refresh)
            _set_refresh_cookie(response, str(refresh), persistent_seconds=persistent_seconds)

        return response


class CookieTokenLogoutView(APIView):
    """Log out: clear the refresh cookie and best-effort blacklist the token.

    Always returns 205 (reset content) — logout is idempotent. If the
    ``token_blacklist`` app is installed, the presented refresh token is
    blacklisted so it cannot be reused after the cookie is cleared; otherwise the
    refresh token remains valid only until its (short) TTL expires.
    """

    permission_classes: list[Any] = []  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012

    @extend_schema(
        request=None,
        responses={205: OpenApiResponse(description="Logged out; refresh cookie cleared.")},
        summary="Log out — clear the refresh cookie and revoke the token",
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raw_token = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        response = Response(status=status.HTTP_205_RESET_CONTENT)

        if raw_token:
            try:
                token = RefreshToken(raw_token)  # type: ignore[arg-type]
                token.blacklist()
            except (TokenError, AttributeError):
                # TokenError: already-expired/invalid token — nothing to revoke.
                # AttributeError: token_blacklist app not installed.
                pass

        _clear_refresh_cookie(response)
        return response
