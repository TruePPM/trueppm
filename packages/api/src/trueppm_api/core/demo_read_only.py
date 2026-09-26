"""Demo read-only mode: deny-by-default write refusal keyed on the deployment (#3912, #3924).

The interactive demo publishes a login. Anything that grants authority through the
*account* is therefore reachable by the whole internet, and no seeded role can help:
``POST /projects/`` is open to any authenticated user and mints the creator an
``OWNER`` membership. So the guarantee cannot be "the demo user's role forbids
writes" -- it has to be "this deployment refuses writes", independent of who asks.

This module is that guarantee, and it is the whole of it: every other decision in the
ADR is defense in depth over this one.

**Why middleware and not a DRF permission class.** A ``DemoReadOnly`` class appended
to ``DEFAULT_PERMISSION_CLASSES`` silently does nothing here: DRF *replaces* its
defaults for any view that sets ``permission_classes`` explicitly, and effectively
every view in this codebase does. Middleware runs ahead of routing and cannot be
overridden per view. It also inverts the default for code that does not exist yet -- an
endpoint added next release by someone who has never heard of the demo is refused by
construction, not permitted until someone notices.

**What is and is not covered.** Every unsafe HTTP request under ``/api/`` is refused.
Not covered, by design: ``/admin/`` (closed by ``DJANGO_ADMIN_ENABLED`` and at the
edge), and WebSocket traffic, which is an ASGI ``websocket`` scope that never enters
HTTP middleware (``/ws/`` is closed at the edge by the demo's web tier). A ``GET`` that writes
as a side effect is also outside a method fence; the middleware refuses methods, not
side effects.
"""

from __future__ import annotations

from collections.abc import Callable

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpRequest, HttpResponse, JsonResponse

#: The stable machine-readable refusal code, documented in ``api/errors.md``.
DEMO_READ_ONLY_CODE = "demo_read_only"

#: The refusal's human-readable ``detail``. The interactive-demo web tier's nginx
#: fence (packages/helm/templates/web/configmap.yaml) refuses writes before they reach
#: Django and must return this exact body, because the web app recognizes a demo
#: refusal by its body. The chart cannot import this constant, so
#: tests/core/test_demo_read_only.py asserts the chart's copy equals it.
DEMO_READ_ONLY_DETAIL = (
    "This is a read-only demo. Your change was not saved. "
    "Nothing in this deployment can be modified."
)

#: Methods that cannot change server state by HTTP's own contract. Everything *not*
#: in this set is treated as a write -- including methods this API never serves
#: (``TRACE``, ``CONNECT``, a made-up verb) -- so an unrecognized method is refused
#: rather than waved through. Listing the safe set, not the unsafe one, is what makes
#: the fence fail closed.
SAFE_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})

#: The complete set of writes permitted while the mode is on, as ``(METHOD, path)``.
#:
#: THIS IS THE WHOLE GUARANTEE. One careless addition re-opens a write path, so
#: ``tests/core/test_demo_read_only.py`` pins the exact contents and fails when the
#: set grows. Every entry must say why it is here. Matched against the resolver's
#: ``path_info`` exactly: no prefix match, no normalization, so
#: ``/api/v1/auth/token/x`` and ``/api/v1/auth/token`` (no slash) are both refused.
ALLOWED_WRITES: frozenset[tuple[str, str]] = frozenset(
    {
        # Login. The visitor has to be able to sign in as the seeded account. Issuing
        # a token is itself a database write (simplejwt's token blacklist records an
        # ``OutstandingToken`` row for every refresh token minted), which is one reason
        # a read-only *database* user was rejected as the mechanism: it would break
        # login.
        ("POST", "/api/v1/auth/token/"),
        # Exchanges the httpOnly refresh cookie for a new short-lived access token.
        # Without it the visitor is logged out when the access token expires. Rotation
        # writes (blacklists the old refresh token, records the new one).
        ("POST", "/api/v1/auth/token/refresh/"),
        # Clears the refresh cookie and blacklists the caller's own token. It can only
        # revoke the caller's own session, so it carries no data-write value.
        ("POST", "/api/v1/auth/logout/"),
    }
)

_TRUE_WORDS = frozenset({"true", "1", "yes", "on"})
_FALSE_WORDS = frozenset({"false", "0", "no", "off", ""})


def parse_demo_read_only(raw: str | None) -> bool:
    """Parse ``TRUEPPM_DEMO_READ_ONLY`` strictly; refuse to boot on an ambiguous value.

    ``environ.Env.bool`` treats every string outside its truthy list as ``False``, so
    a typo such as ``ture`` would silently *disable* the one control the demo's safety
    rests on. Here an unrecognized value raises instead: an operator who fat-fingers
    the flag gets a process that will not start, not a demo that looks read-only and
    is not. Unset and empty mean off, so a normal install is unaffected.

    Args:
        raw: The raw environment value, or ``None`` when the variable is unset.

    Returns:
        ``True`` when the mode is on, ``False`` when it is off.

    Raises:
        ImproperlyConfigured: If ``raw`` is set to anything other than a recognized
            boolean word.
    """
    if raw is None:
        return False
    word = raw.strip().lower()
    if word in _TRUE_WORDS:
        return True
    if word in _FALSE_WORDS:
        return False
    raise ImproperlyConfigured(
        f"TRUEPPM_DEMO_READ_ONLY={raw!r} is not a recognized boolean. Use true/false "
        "(or 1/0, yes/no, on/off). Refusing to start: a misspelled value would "
        "otherwise leave the demo writable while looking read-only."
    )


def parse_demo_login_hint(raw: str | None) -> dict[str, str] | None:
    """Parse ``TRUEPPM_DEMO_LOGIN_HINT`` into the credential the login page prints.

    The interactive demo publishes one shared account, so the login screen has to
    *show* it — a visitor with no credential is a visitor who leaves. The value is a
    ``username:password`` pair, and it is deliberately its own variable rather than
    something derived from whatever password the seed job used: nothing should be able
    to turn a real password into published copy by accident, so the operator states the
    published pair explicitly or the panel does not render at all.

    Splits on the **first** colon only, so a password may contain colons.

    Args:
        raw: The raw environment value, or ``None`` when the variable is unset.

    Returns:
        ``{"username": …, "password": …}``, or ``None`` when unset or empty. Whitespace
        around the **whole** value is stripped before the split, so a trailing newline
        from a heredoc or a ConfigMap block scalar does not become part of the
        password; whitespace *inside* the password is preserved.

    Raises:
        ImproperlyConfigured: If ``raw`` is set to something that is not a
            ``username:password`` pair. Refusing to boot is the same trade-off
            ``parse_demo_read_only`` makes one function up: a demo whose one
            advertised credential is a typo is a demo nobody can sign in to, and an
            operator would rather find that at boot than in a visitor's bug report.
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    username, sep, password = value.partition(":")
    if not sep or not username.strip() or not password:
        raise ImproperlyConfigured(
            "TRUEPPM_DEMO_LOGIN_HINT must be 'username:password' with both halves "
            "non-empty. Refusing to start rather than publishing a demo whose only "
            "advertised credential is unusable."
        )
    return {"username": username.strip(), "password": password}


#: URL schemes the access-gate privacy link may use. The value is rendered as an
#: ``href`` on a public pre-auth page, so it is held to the same bar as any other
#: link an unauthenticated visitor is handed -- ``https://`` only. ``javascript:``
#: and ``data:`` must be unreachable even though the value comes from the operator
#: rather than a visitor -- a chart value copied between deployments is not a
#: trusted input -- and ``http://`` is refused too rather than rendering a plaintext
#: link on an otherwise-TLS page (#3997).
_ALLOWED_PRIVACY_URL_SCHEMES = ("https://",)


def parse_demo_access_gate(
    raw_provider: str | None, raw_privacy_url: str | None
) -> dict[str, str | None] | None:
    """Parse the external access gate an operator declares in front of the demo.

    A demo host may sit behind a third-party identity gate -- Cloudflare Access,
    Authelia, Authentik, Google IAP -- that makes every visitor hand over an email
    address *before* any TruePPM code runs. ADR-1197 D8 records that such a gate is
    **not** a security control here, and that its email collection is a PII asset the
    project does not otherwise hold. #3969 resolves the disclosure half of that: the
    app says so, in the app, when and only when a gate is actually declared.

    **This is an operator assertion and nothing verifies it.** The gate lives in a
    third-party dashboard outside the cluster; no request the API can make will
    confirm it is armed, and turning it off in that dashboard leaves this value
    untouched. A stale ``true`` therefore over-discloses (claims a collection that
    stopped) and an unset value under-discloses (a real gate nobody declared). Header
    corroboration (``Cf-Access-Jwt-Assertion``) was considered and rejected in the
    #3969 architect pass: it would be stripped by the chart's own web tier and fail
    *closed*, which is the dangerous direction for a disclosure. Declaring fails open.

    The provider name is deliberately operator-supplied rather than a constant. A
    self-hoster running this same demo mode behind Authelia must not be made to
    publish a notice naming Cloudflare, which is exactly the false claim #3969's
    scope note forbids.

    Args:
        raw_provider: ``TRUEPPM_DEMO_ACCESS_GATE_PROVIDER`` -- the gate's display
            name, e.g. ``"Cloudflare Access"``. Unset or empty means no gate is
            declared, which is the default and the normal-install case.
        raw_privacy_url: ``TRUEPPM_DEMO_ACCESS_GATE_PRIVACY_URL`` -- optional link to
            the privacy statement covering what that gate collects.

    Returns:
        ``{"provider": …, "privacy_url": … | None}``, or ``None`` when no provider is
        declared. A privacy URL without a provider is ``None`` too: the link is an
        attribute of a declared gate, not a disclosure on its own.

    Raises:
        ImproperlyConfigured: If the privacy URL is not https. Refusing to boot
            follows the same trade-off as the parsers above -- a disclosure carrying a
            dead or hostile link is worse than a deployment that will not start, and
            the operator finds out now rather than from a visitor.
    """
    provider = (raw_provider or "").strip()
    if not provider:
        return None
    privacy_url = (raw_privacy_url or "").strip()
    if privacy_url and not privacy_url.lower().startswith(_ALLOWED_PRIVACY_URL_SCHEMES):
        raise ImproperlyConfigured(
            f"TRUEPPM_DEMO_ACCESS_GATE_PRIVACY_URL={raw_privacy_url!r} must start with "
            "https://. It is rendered as a link on the pre-auth login page, so any "
            "other scheme -- including plain http:// -- is refused rather than "
            "sanitized at use."
        )
    return {"provider": provider, "privacy_url": privacy_url or None}


def parse_demo_reset_schedule(raw: str | None) -> str | None:
    """Parse ``TRUEPPM_DEMO_RESET_SCHEDULE`` into the cadence the demo bar states (#4152).

    The chart renders the CronJob's own ``demo.reset.schedule`` cron expression onto
    this variable — empty when ``demo.reset.enabled`` is false (ADR-1197 D9) — so the
    login page and the shell's demo bar can state the cadence from the one value the
    CronJob is actually driven by, rather than a hardcoded number that silently drifts
    the moment an operator retunes the schedule.

    Deliberately **not** validated as a cron expression here. Unlike
    :func:`parse_demo_read_only`, a malformed value here is cosmetic, not a safety
    guarantee: the worst case is the web falling back to "resets periodically" (see
    ``DemoModeBar``'s daily-cadence parser), never a control that looks armed and is
    not. The CronJob's own schedule field is what Kubernetes validates.

    Args:
        raw: The raw environment value, or ``None``/empty when unset or when the reset
            is disabled.

    Returns:
        The stripped cron expression, or ``None`` when unset, empty, or whitespace-only.
    """
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def _is_api_path(path_info: str) -> bool:
    """Whether ``path_info`` addresses the API, ignoring any run of leading slashes.

    Stripping every leading slash means ``//api/v1/...`` is still treated as the API
    and refused. The resolver would 404 that path today; the point is that the fence
    does not depend on that staying true.
    """
    return path_info.lstrip("/").startswith("api/")


class DemoReadOnlyMiddleware:
    """Refuse every unsafe request under ``/api/`` when demo read-only mode is on.

    Keyed on the **real** HTTP method (``request.method``). Nothing here reads
    ``X-HTTP-Method-Override``, a ``_method`` form field, or any other client-supplied
    substitute, and neither does Django or DRF, so a ``POST`` cannot be downgraded to
    a ``GET`` (or the reverse) by a header. ``tests/core/test_demo_read_only.py`` pins
    that.

    Placed **ahead of session and authentication** (see ``MIDDLEWARE``) so anonymous
    requests are refused too -- password-reset request, the SSO views, the inbound
    integration receivers and the ``AllowAny`` workspace views. The password-reset
    request is the one that matters most: it sends mail to an arbitrary address, so
    refusing it is what stops the demo being used as an email relay. It also runs
    before the view's ``ATOMIC_REQUESTS`` transaction opens, so a refused request
    costs no database work at all.

    Fail-closed: the flag is read on every request and only an exact ``False`` lets a
    request through, so a non-boolean setting value refuses rather than disables. Off
    by default, and when off the cost is one settings lookup and a return.

    Deliberately synchronous, like its neighbors in ``MIDDLEWARE``: there is no I/O to
    await, and Django adapts sync middleware in an async stack.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if getattr(settings, "DEMO_READ_ONLY", False) is False:
            return self.get_response(request)

        method = (request.method or "").upper()
        if (
            method not in SAFE_METHODS
            and _is_api_path(request.path_info)
            and (method, request.path_info) not in ALLOWED_WRITES
        ):
            # Plain JsonResponse, not a DRF Response: this runs before the view, so
            # there is no exception handler in play and nothing to roll back.
            return JsonResponse(
                {
                    "detail": DEMO_READ_ONLY_DETAIL,
                    "code": DEMO_READ_ONLY_CODE,
                },
                status=403,
            )
        return self.get_response(request)
