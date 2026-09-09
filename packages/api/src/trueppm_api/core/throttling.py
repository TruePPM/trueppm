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

``/api/v1/readyz`` is deliberately **not** in that exempt set (#2820, #3346).
Unlike ``/health/`` and ``/edition/`` it is not free — every call does a real
database and cache round-trip — so a full exemption meant an unauthenticated
caller who reached the pod IP directly (the probe path bypasses the Ingress)
could drive unbounded database load with no rate limit at all. It gets its own
scoped throttle instead (``ReadyzRateThrottle`` below), generous enough that no
documented probe configuration comes close to tripping it.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, cast

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

# Kubernetes liveness and edition-discovery probes. Free to answer (no DB/cache
# round-trip) and hit on a tight orchestrator loop, so the general default
# throttle must never count them (returning None from get_cache_key skips
# throttling for the request). Stored trailing-slash-normalized so the check is
# robust whether or not the request path carries the trailing slash.
#
# ``/api/v1/readyz`` is NOT here — see ``ReadyzRateThrottle`` below (#2820,
# #3346): unlike these two it does real dependency round-trips, so it gets its
# own bounded scope instead of a blanket exemption.
_PROBE_EXEMPT_PATHS = frozenset(
    path.rstrip("/") for path in ("/api/v1/health/", "/api/v1/edition/")
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
        # ``hasattr(request, "data")`` alone is insufficient: a non-object JSON body
        # (list/str/scalar) makes ``request.data`` a non-dict with no ``.get``, which
        # would raise AttributeError inside check_throttles → 500 before the login
        # serializer ever runs (#2126). A non-object body carries no username, so
        # treat it as "no username" → skip this throttle (the IP throttle still bites).
        username = request.data.get("username") if isinstance(request.data, dict) else None
        if not username:
            return None
        return self.cache_key_for(str(username))

    @classmethod
    def cache_key_for(cls, identifier: str) -> str:
        """Return the bucket key for ``identifier``.

        The single owner of this throttle's key derivation. ``get_cache_key`` and
        ``charge`` must not each spell the hash out, or the two drift and the
        canonical charge silently stops landing in the bucket ``get_cache_key``
        reads.
        """
        ident = hashlib.sha256(identifier.strip().lower().encode("utf-8")).hexdigest()
        return cls.cache_format % {"scope": cls.scope, "ident": ident}

    @classmethod
    def consume(cls, identifier: str) -> float | None:
        """Record one attempt against ``identifier``'s bucket and report the verdict.

        Returns ``None`` when the attempt was within the rate, or the number of
        seconds to wait when the bucket was already at its limit.

        Why this exists (#3468): the throttle runs in ``check_throttles``, *before*
        the view body, so it can only ever key on the identifier as submitted. Once
        one account answers to two identifiers (its username and its email), an
        attacker gets two independent per-account buckets and the effective guess
        allowance against that account doubles — which defeats exactly the cross-IP
        protection #1717 added. Resolving the email inside ``get_cache_key`` would
        put an unauthenticated, unindexed ``email__iexact`` query in front of *every*
        login, so instead the login view calls this once it has resolved an email to
        its canonical username.

        **Recording is not enough, and the half-measure is the trap.** The username
        bucket already accumulates every username-form attempt (DRF charges it in
        ``allow_request``) and now every email-form attempt too, so it holds the true
        total — but nothing *checks* it on the email path, and an attacker who spends
        the username budget first then finds the email's own bucket empty and gets a
        second full allowance. Only the email-first order would be capped, which is
        worse than not fixing it at all: the protection looks complete and is
        order-dependent. So this both records **and** reports, and the view refuses
        on a ``None``-less return.

        The residual is a narrow oracle and it is the right trade: an attacker who
        already knows a username, and who spends that account's entire per-window
        budget on it, can then learn whether a given address belongs to that same
        account by whether they get a 429 rather than a 401. That leaks a mapping
        between two identifiers of one already-known account, at one bit per window,
        at the cost of the guesses they came for — against doubling the brute-force
        budget on every targeted account, permanently.

        Charging after the fact (rather than pre-emptively) matches how DRF throttles
        work anyway — the Nth attempt is served and the N+1th is refused.
        """
        throttle = cls()
        if not throttle.rate:
            # No rate configured for this scope — nothing to charge, nothing to refuse.
            return None
        throttle.key = cls.cache_key_for(identifier)
        throttle.now = throttle.timer()

        # Evict entries that have aged out of the window before recording, exactly as
        # ``SimpleRateThrottle.allow_request`` does. ``throttle_success`` refreshes the
        # cache TTL on every write, so without this an entry could outlive the window
        # it belongs to and over-throttle the account. ``duration`` is set in
        # ``SimpleRateThrottle.__init__`` from ``parse_rate`` but is not declared on the
        # class, so it carries no type for mypy --strict.
        duration = cast("int", getattr(throttle, "duration", 0))
        history: list[float] = list(throttle.cache.get(throttle.key, []))
        while history and history[-1] <= throttle.now - duration:
            history.pop()
        throttle.history = history
        # ``num_requests`` and ``duration`` are set in ``SimpleRateThrottle.__init__``
        # from ``parse_rate`` but are not declared on the class, so they carry no type.
        if len(history) >= cast("int", getattr(throttle, "num_requests", 0)):
            # Already at the limit before this attempt. Report the wait and record
            # nothing — DRF's own throttle_failure does not extend the window either,
            # so a refused attempt must not push the bucket's expiry out.
            return throttle.wait()
        throttle.throttle_success()
        return None


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


class ReadyzRateThrottle(AnonRateThrottle):
    """Dedicated, generous rate limit for the unauthenticated ``/readyz`` probe.

    (#2820, #3346) ``/readyz`` must stay unauthenticated — kubelet carries no
    credential — but it is not free the way ``/health/`` and ``/edition/`` are:
    every call does a bounded database round-trip, a cache round-trip, and a
    migration-state check. Before this it was fully exempt from the shared
    throttle (see ``_PROBE_EXEMPT_PATHS``), which meant an unauthenticated
    caller who reached the pod IP directly — the probe path bypasses the
    Ingress entirely — could drive unbounded database load with no rate limit
    of any kind.

    A dedicated ``"readyz"`` scope rather than the shared ``"anon"`` bucket, on
    purpose: kubelet's readiness/startup probes hit the pod IP directly from
    the node, not through the Ingress, so their source IP is the node's, not an
    end user's. Sharing "anon" would let a legitimate probe loop compete with
    real anonymous traffic in both directions — draining the budget a genuine
    anonymous client needs, or (with a generous enough rate to avoid that)
    giving an attacker room under the anon scope they would not otherwise have.
    The rate itself (``DEFAULT_THROTTLE_RATES["readyz"]``) is picked to clear
    every documented probe configuration with room to spare — see
    administration/probes.md for the numbers it assumes — while still bounding
    an outright flood.
    """

    scope = "readyz"
