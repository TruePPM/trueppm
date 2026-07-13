"""Probe-exempt default throttles for the general API rate limit (#1080).

TruePPM installs a global ``DEFAULT_THROTTLE_CLASSES`` so every endpoint that
does not declare its own scoped throttle still gets a baseline anon/user rate
limit (bounded DoS / resource-starvation protection for self-hosters). The one
hazard a *global* throttle introduces is that it would also count the
unauthenticated Kubernetes probe endpoints — ``/api/v1/health/`` (liveness) and
``/api/v1/edition/`` (the shell's startup edition read) — which orchestrators
hit on a tight loop. If those requests consumed the shared anon bucket, a busy
readiness loop could 429 the liveness probe and cause Kubernetes to restart a
perfectly healthy pod.

This is exactly why ``settings/base.py`` historically shipped *scoped throttles
only* and deliberately avoided a bare ``AnonRateThrottle``. The classes below
resolve that tension: they are the standard DRF anon/user throttles with a
single override — ``get_cache_key`` returns ``None`` (which DRF treats as "do
not throttle this request") for the probe paths — so the global default can be
turned on without ever rate-limiting a k8s probe.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

from rest_framework.request import Request
from rest_framework.throttling import (
    AnonRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)

if TYPE_CHECKING:
    # Imported for type hints only. A runtime ``from rest_framework.views import
    # APIView`` would be circular: DRF's ``APIView`` class body eagerly resolves
    # ``DEFAULT_THROTTLE_CLASSES`` (→ this module) while ``rest_framework.views``
    # is still initializing, before ``APIView`` itself is bound. ``from __future__
    # import annotations`` keeps the annotations below as strings, so this import
    # is never needed at runtime.
    from rest_framework.views import APIView

# Kubernetes liveness/readiness and edition-discovery probes. These are
# unauthenticated and hit on a tight orchestrator loop, so the general default
# throttle must never count them (returning None from get_cache_key skips
# throttling for the request). Stored trailing-slash-normalized so the check is
# robust whether or not the request path carries the trailing slash.
_PROBE_EXEMPT_PATHS = frozenset(
    path.rstrip("/") for path in ("/api/v1/health/", "/api/v1/readyz", "/api/v1/edition/")
)


def _is_probe_path(request: Request) -> bool:
    """Return True when the request targets an exempt k8s probe endpoint.

    Matches on ``path_info`` (the path *without* any ``SCRIPT_NAME`` mount prefix)
    so the exemption still fires when TruePPM is served under a sub-path — otherwise
    a probe at ``/trueppm/api/v1/health/`` would carry the prefix in ``request.path``,
    miss the exempt set, and get throttled: the exact failure this guards against.
    """
    return request.path_info.rstrip("/") in _PROBE_EXEMPT_PATHS


class ProbeExemptAnonRateThrottle(AnonRateThrottle):
    """Anonymous default throttle that never counts the k8s probe endpoints.

    Inherits the ``"anon"`` scope, so its rate comes from
    ``DEFAULT_THROTTLE_RATES["anon"]``. Only the probe exemption is added; all
    other requests are throttled exactly like the stock ``AnonRateThrottle``.
    """

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        """Skip throttling for probe paths; otherwise defer to DRF's default.

        Returning ``None`` tells DRF not to record or limit this request, which
        keeps the tight-loop liveness/readiness probes off the shared anon
        bucket (see module docstring).
        """
        if _is_probe_path(request):
            return None
        return super().get_cache_key(request, view)


class LoginAccountRateThrottle(SimpleRateThrottle):
    """Per-*account* login throttle, keyed on the submitted username (#1717).

    Why this exists alongside the IP-keyed ``login`` throttle:
        The stock login throttle keys only on the client IP, so it caps guesses
        *per source address*. A distributed credential-stuffing attack against a
        single account rotates through a botnet / proxy pool, giving the attacker
        the full per-IP allowance from every fresh IP — the aggregate guess rate
        against that one account is unbounded even though no single IP trips the
        limit. This throttle closes that gap by counting failed *and* successful
        attempts against the same normalized username regardless of source IP, so
        an account under distributed attack is locked out after the per-account
        rate no matter how many IPs participate. It is *stacked* with (not a
        replacement for) the IP throttle: both must pass, so IP-local flooding and
        cross-IP account targeting are each bounded.

    Privacy: the username is lowercased/trimmed and SHA-256 hashed before it goes
    into the cache key, so the raw email/username is never persisted in the cache
    backend (or leaked through a cache-key dump). Hashing is sufficient here — the
    key only needs to be stable and collision-resistant, not reversible.

    This is basic brute-force hardening (table-stakes self-hosting security), not
    an org-wide enforced lockout *policy* with admin-configurable escalation /
    unlock workflows — that governance layer is Enterprise.
    """

    scope = "login_account"

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        """Key the throttle on the hashed, normalized submitted username.

        Returns ``None`` (skip this throttle) when no username is present so a
        malformed request is not charged against an empty-string bucket — the IP
        throttle still applies to those. Reading ``request.data`` here parses the
        request body once (DRF caches it), which is safe inside ``check_throttles``.
        """
        username = request.data.get("username") if hasattr(request, "data") else None
        if not username:
            return None
        normalized = str(username).strip().lower()
        ident = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class ProbeExemptUserRateThrottle(UserRateThrottle):
    """Authenticated default throttle that never counts the k8s probe endpoints.

    Inherits the ``"user"`` scope, so its rate comes from
    ``DEFAULT_THROTTLE_RATES["user"]``. Only the probe exemption is added; all
    other requests are throttled exactly like the stock ``UserRateThrottle``.
    """

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        """Skip throttling for probe paths; otherwise defer to DRF's default.

        Returning ``None`` tells DRF not to record or limit this request, which
        keeps the tight-loop liveness/readiness probes off the shared user
        bucket (see module docstring).
        """
        if _is_probe_path(request):
            return None
        return super().get_cache_key(request, view)
