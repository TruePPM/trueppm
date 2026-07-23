"""Global rate-limiting kill switch (ADR-0604, extends ADR-0208).

An operator-only escape hatch to disable **all** DRF throttling — e.g. to measure
raw throughput in a k6 load test, or to run the full stack locally without
fighting per-account limits. Disabling rate limiting removes a DoS/abuse
protection, so it is deliberately hard to enable by accident:

* ``TRUEPPM_RATE_LIMIT_ENABLED`` (bool, default ``True``) must be set false, **and**
* ``TRUEPPM_RATE_LIMIT_DISABLE_ACK`` must equal :data:`RATE_LIMIT_DISABLE_ACK_SENTINEL`.

Both are required in **every** environment (the acknowledgment is *not* gated on
``DEBUG``): a uniform "disabling a security control always needs the explicit
sentinel" invariant is simpler to reason about and leaves no ``DEBUG``-dependent
edge case. A disable request without the exact sentinel is **ignored** — rate
limiting stays on — and reported at ``CRITICAL``, so a stray env var can never
silently open a DoS path. The refusal fails toward the *protected* state (limits
on), never toward an outage: a fat-fingered flag must not remove protection *or*
crash the app, so this deliberately does **not** ``raise`` the way the
unencrypted-DB guard does.

This is deploy-time operator config, never a UI/API toggle — an authenticated
user must not be able to switch off a platform DoS protection (ADR-0497). The
live state is surfaced read-only to workspace admins via ``/health/system/`` and
a banner, and to monitoring via the ``trueppm.ratelimit.enabled`` OTEL gauge.

The logic here is split into small pure functions so both the two-key
acknowledgment resolution and the DRF-config transform are unit-testable without
booting Django or mutating process env.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from collections.abc import MutableMapping

    from rest_framework.request import Request
    from rest_framework.throttling import BaseThrottle
    from rest_framework.views import APIView

# Bound as a string so ``rest_framework`` is never imported at runtime here — this
# module is imported at settings-load time, and importing DRF that early risks the
# ``rest_framework.views`` circular-import hazard documented in core/throttling.py.
_ThrottleT = TypeVar("_ThrottleT", bound="BaseThrottle")

# The exact acknowledgment an operator must set in ``TRUEPPM_RATE_LIMIT_DISABLE_ACK``
# (alongside ``TRUEPPM_RATE_LIMIT_ENABLED=false``) to actually disable rate
# limiting. Required in every environment. Documented verbatim in
# docs/administration and referenced by ADR-0604; treat as a stable operator
# contract — do not change the string without a deprecation note.
RATE_LIMIT_DISABLE_ACK_SENTINEL = "i-understand-this-disables-abuse-protection"

_DISABLED_MESSAGE = (
    "API rate limiting is DISABLED (TRUEPPM_RATE_LIMIT_ENABLED=false with a valid "
    "acknowledgment). Every DRF throttle — including the fail-closed sync write-path "
    "throttle — is bypassed. This removes DoS/abuse protection and must never be set "
    "on a production-facing deployment."
)
_REFUSED_MESSAGE = (
    "Ignoring TRUEPPM_RATE_LIMIT_ENABLED=false: the required acknowledgment "
    "TRUEPPM_RATE_LIMIT_DISABLE_ACK is missing or does not match the documented "
    "sentinel. API rate limiting remains ENABLED. This is the safe default — a stray "
    "disable flag never silently removes abuse protection."
)


def resolve_rate_limit_enabled(*, requested_enabled: bool, ack: str) -> tuple[bool, str | None]:
    """Resolve the effective rate-limit switch from the two operator env inputs.

    Args:
        requested_enabled: value of ``TRUEPPM_RATE_LIMIT_ENABLED`` (default True).
        ack: value of ``TRUEPPM_RATE_LIMIT_DISABLE_ACK`` (default "").

    Returns:
        ``(enabled, critical_message)``. ``critical_message`` is non-None whenever
        the operator asked to disable rate limiting — either confirming the
        (acknowledged) disable or reporting that an unacknowledged disable was
        refused — so the caller logs it at ``CRITICAL``. The default (enabled)
        path is silent.
    """
    if requested_enabled:
        return True, None
    if ack == RATE_LIMIT_DISABLE_ACK_SENTINEL:
        return False, _DISABLED_MESSAGE
    # Disable requested without the exact acknowledgment: refuse. Fail toward the
    # protected state (limits ON), never toward an outage.
    return True, _REFUSED_MESSAGE


def apply_rate_limit_disable(rest_framework_config: MutableMapping[str, Any]) -> None:
    """Neutralize every DRF throttle in a REST_FRAMEWORK config, in place.

    Drops ``DEFAULT_THROTTLE_CLASSES`` and sets every ``DEFAULT_THROTTLE_RATES``
    value to ``None`` — DRF's ``SimpleRateThrottle.allow_request`` returns True
    immediately when its resolved rate is ``None``, so this disables *all*
    SimpleRateThrottle-family throttles (defaults, scoped, MCP, invite,
    monte-carlo, share, and any added later) from a single place, with no
    per-class edits. Called from settings only when the operator has disabled
    rate limiting with a valid acknowledgment.

    The custom Redis ``BaseThrottle`` classes (task-sync, sync-upload, mentions,
    …) do not read these rates, so they check the flag at request time via
    :func:`rate_limiting_disabled` instead. Idempotent.
    """
    rest_framework_config["DEFAULT_THROTTLE_CLASSES"] = []
    rates = rest_framework_config.get("DEFAULT_THROTTLE_RATES") or {}
    rest_framework_config["DEFAULT_THROTTLE_RATES"] = dict.fromkeys(rates, None)


def bypass_when_disabled(throttle_cls: type[_ThrottleT]) -> type[_ThrottleT]:
    """Class decorator: allow all requests when the global kill switch is off.

    Wraps a throttle's ``allow_request`` so it returns ``True`` — checked at
    *request* time, before any Redis work — whenever an operator has disabled
    rate limiting (ADR-0604). Applied to the custom Redis ``BaseThrottle``
    throttles (task-sync, sync-upload, git-webhook, task-link-refresh, mentions,
    token-issuance, attachment-upload), which resolve their own limits from Redis
    and so are *not* covered by the ``DEFAULT_THROTTLE_RATES`` transform in
    settings. One decorator line per class keeps the bypass explicit, greppable,
    and testable via ``override_settings`` — with no edit inside each method body.

    Deliberately bypasses even the fail-closed sync write-path throttle: an
    operator who acknowledged the disable gets "off means off" with no hidden
    exceptions, so the read-only status surfaced to admins is literally accurate.
    """
    original = throttle_cls.allow_request

    def allow_request(self: BaseThrottle, request: Request, view: APIView) -> bool:
        if rate_limiting_disabled():
            return True
        return bool(original(self, request, view))

    throttle_cls.allow_request = allow_request  # type: ignore[method-assign]
    return throttle_cls


def rate_limiting_disabled() -> bool:
    """True when the global kill switch has disabled all throttling.

    Read at *request* time by every custom Redis throttle so ``override_settings``
    and a live operator change take effect. Defaults to False (limits on) if the
    setting is somehow absent, so a misconfiguration never silently drops
    protection.
    """
    from django.conf import settings

    return getattr(settings, "RATE_LIMIT_ENABLED", True) is False
