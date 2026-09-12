"""Refresh-cookie ``SameSite`` validation (#3556, follows ADR-0604's ack pattern).

``TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE`` was, before this module, a free-form env
override with no validation: whatever string an operator set landed verbatim on
``Set-Cookie`` (see ``_set_refresh_cookie`` in ``core/auth_views.py``). The refresh
and logout endpoints are authenticated by that cookie alone — no CSRF token, no
double-submit — so ``SameSite=Strict`` (the shipped default) is the *only* control
that stops a forged cross-site request from riding the cookie. An operator who
sets the override to ``None`` (or, for a split-origin deploy, ``Lax``) removes or
weakens that control, and nothing said so.

This mirrors ``core/ratelimit.py``'s two-key acknowledgment shape rather than
inventing a new one: disabling a security control always needs an explicit,
documented sentinel, and the resolution is a pure function so it is unit-testable
without booting Django or mutating process env. Unlike the rate-limit switch this
one is a three-way choice, not a boolean, so the return shape carries a
``warning`` and a ``critical`` slot instead of one message — at most one of the
two is populated for any resolution:

* ``Strict`` (default or explicit) — the safe value. Silent.
* ``Lax`` — accepted as-is (a split-origin/iframe deploy may need it), but logged
  at WARNING naming the consequence: the cookie stops riding cross-site *POSTs*
  from another origin (the actual CSRF vector these endpoints care about), while
  still riding a top-level cross-site *navigation*.
* ``None`` with the exact acknowledgment sentinel
  (:data:`REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL` in
  ``TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE_NONE_ACK``) — accepted, but logged at
  CRITICAL: this removes the SameSite CSRF backstop entirely and relies solely on
  the ``Sec-Fetch-Site`` / ``Origin`` defense-in-depth check in
  ``core/auth_views.py``.
* ``None`` without the sentinel, or any value that is not one of the three
  recognized words — refused. Falls back to ``Strict`` (fail toward the
  *protected* state, exactly like an unacknowledged rate-limit disable) and logs
  at CRITICAL so a typo or a fat-fingered override can never silently weaken the
  cookie; it can only be silently ignored in favor of the safe default.
"""

from __future__ import annotations

from typing import Literal, NamedTuple

#: The precise literal type Django's ``HttpResponseBase.set_cookie``/``delete_cookie``
#: stubs declare for ``samesite=``. Typing :attr:`RefreshCookieSameSiteResolution.value`
#: as this — rather than a bare ``str`` — is what lets ``AUTH_REFRESH_COOKIE_SAMESITE``
#: type-check at its call sites in ``core/auth_views.py`` (django-stubs' mypy plugin
#: infers a settings attribute's type from its assignment in ``settings/base.py``).
SameSiteValue = Literal["Strict", "Lax", "None"]

#: The exact acknowledgment an operator must set in
#: ``TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE_NONE_ACK`` (alongside
#: ``TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE=None``) to actually drop SameSite
#: protection on the refresh cookie. Documented verbatim in
#: administration/configuration.md; treat as a stable operator contract — do not
#: change the string without a deprecation note.
REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL = "i-understand-this-removes-refresh-csrf-protection"

#: The only values Django's cookie machinery treats as a real SameSite policy.
#: Compared case-insensitively so ``lax``/``LAX``/``Lax`` all resolve the same way,
#: but the *stored* setting is always one of these three canonical spellings —
#: never the operator's raw casing — so nothing downstream (the ``Set-Cookie``
#: header, ``_clear_refresh_cookie``'s matching ``delete_cookie`` call) can drift
#: from what this function decided.
_VALID_SAMESITE_VALUES = ("Strict", "Lax", "None")

_LAX_WARNING = (
    "TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE=Lax: the refresh cookie no longer blocks "
    "cross-site requests unconditionally. Lax still withholds the cookie from a "
    "cross-site POST (the vector that matters for CookieTokenRefreshView / "
    "CookieTokenLogoutView), but attaches it to a cross-site top-level GET "
    "navigation. Use this only for a deploy that genuinely needs the cookie to "
    "survive top-level navigation from another site; the Sec-Fetch-Site / Origin "
    "check in core/auth_views.py is defense in depth, not a substitute."
)

_NONE_ACKED_CRITICAL = (
    "TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE=None is ACTIVE (acknowledged via "
    "TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE_NONE_ACK). The refresh cookie now rides "
    "on every cross-site request, browser-enforced SameSite protection is fully "
    "removed from CookieTokenRefreshView and CookieTokenLogoutView, and the only "
    "remaining control is the Sec-Fetch-Site / Origin check in core/auth_views.py "
    "— which a non-browser client bypasses by sending neither header. Set this "
    "only when TruePPM is genuinely framed or called cross-site and you have "
    "verified CSRF_TRUSTED_ORIGINS is complete."
)

_NONE_UNACKED_CRITICAL = (
    "Ignoring TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE=None: it removes the only "
    "unconditional CSRF control on the refresh/logout endpoints, and the required "
    "acknowledgment TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE_NONE_ACK is missing or "
    "does not match the documented sentinel. Falling back to SameSite=Strict. "
    "This is the safe default — a stray override never silently removes the "
    "cookie's CSRF protection."
)

_UNRECOGNIZED_CRITICAL_TEMPLATE = (
    "TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE={value!r} is not a recognized SameSite "
    "value (Strict, Lax, None) — falling back to SameSite=Strict. An unrecognized "
    "value is not a Django CSRF posture at all; browsers that honor the raw string "
    "verbatim may fail closed and drop the cookie, while a permissive parser could "
    "treat it as Lax or None. Set the value to one of Strict / Lax / None, or unset "
    "the variable to accept the Strict default."
)


class RefreshCookieSameSiteResolution(NamedTuple):
    """The effective ``SameSite`` value plus at most one log-worthy message."""

    value: SameSiteValue
    warning: str | None
    critical: str | None


def resolve_refresh_cookie_samesite(*, requested: str, ack: str) -> RefreshCookieSameSiteResolution:
    """Resolve the effective refresh-cookie ``SameSite`` value from operator env.

    Args:
        requested: raw ``TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE`` (or legacy
            ``AUTH_REFRESH_COOKIE_SAMESITE``) value, already applying that
            fallback chain — this function only validates the resolved string.
        ack: raw ``TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE_NONE_ACK`` value.

    Returns:
        A :class:`RefreshCookieSameSiteResolution`. ``value`` is always one of
        ``"Strict"``, ``"Lax"``, ``"None"`` — never the raw operator string — so
        callers can pass it straight to ``response.set_cookie(samesite=...)``
        without re-validating.
    """
    stripped = (requested or "").strip()
    lowered = stripped.lower()
    normalized = next(
        (candidate for candidate in _VALID_SAMESITE_VALUES if candidate.lower() == lowered),
        None,
    )

    if normalized is None:
        # Blank resolves through the env() default chain to "Strict" before this
        # function ever runs, so an empty string here means the operator set the
        # var to whitespace/empty explicitly — treat it the same as any other
        # unrecognized value rather than special-casing it into silence.
        message = _UNRECOGNIZED_CRITICAL_TEMPLATE.format(value=requested)
        return RefreshCookieSameSiteResolution(value="Strict", warning=None, critical=message)

    if normalized == "Strict":
        return RefreshCookieSameSiteResolution(value="Strict", warning=None, critical=None)

    if normalized == "Lax":
        return RefreshCookieSameSiteResolution(value="Lax", warning=_LAX_WARNING, critical=None)

    # normalized == "None"
    if ack == REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL:
        return RefreshCookieSameSiteResolution(
            value="None", warning=None, critical=_NONE_ACKED_CRITICAL
        )
    return RefreshCookieSameSiteResolution(
        value="Strict", warning=None, critical=_NONE_UNACKED_CRITICAL
    )
