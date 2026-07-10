"""Per-token rate limits for the MCP read surface (ADR-0186, #1808 finding F4).

Every view mixing in
:class:`~trueppm_api.apps.access.permissions.McpReadableViewMixin` is additively
reachable by a personal ``mcp:read`` API token. Those token-authenticated reads
had no rate bound: an agent retry loop — or a hostile client holding a leaked
read-only token — could hammer the surface, and the compute-heavy tools
(``whatif``, ``monte-carlo/latest``, ``forecast``, ``sprint-forecast``) each
trigger a CPM + Monte Carlo recompute per call, so an unbounded loop burns
arbitrary CPU on a read-only credential.

Two throttles bound the *token* caller only. :meth:`get_cache_key` returns
``None`` for any non-token (human JWT/Session) request, which DRF treats as "not
throttled" — so interactive human traffic on the same views is unaffected
(#1808 scope: do not throttle human/session traffic). This is the OSS seed of the
Phase-4 per-agent budget work; per-agent budgets and anomaly auto-suspend remain
Enterprise.

Keyed on the token's own id (not the owner user) so each minted token carries its
own bucket: revoking or re-minting a token starts a fresh window, and two agents
holding two distinct tokens neither share nor starve one budget.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from rest_framework.throttling import SimpleRateThrottle

if TYPE_CHECKING:
    from rest_framework.request import Request
    from rest_framework.views import APIView


class _McpTokenThrottle(SimpleRateThrottle):
    """Base: throttle a request only when it is authenticated by an API token.

    A non-token caller (human JWT/Session) yields ``None`` from
    :meth:`get_cache_key`, which DRF interprets as "skip this throttle entirely",
    so the baseline ``user``/scoped throttles remain the only bound on human
    traffic. A token caller is bucketed on the token's own primary key.
    """

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        # Local import: the model layer is not import-safe at settings-load time.
        from trueppm_api.apps.projects.models import ApiToken

        token = getattr(request, "auth", None)
        if not isinstance(token, ApiToken):
            return None  # human JWT/Session — not the MCP surface this throttle guards
        return self.cache_format % {"scope": self.scope, "ident": str(token.pk)}


class McpTokenReadThrottle(_McpTokenThrottle):
    """Baseline per-token cap applied across the whole MCP read surface."""

    scope = "mcp_read"


class McpTokenComputeThrottle(_McpTokenThrottle):
    """Tighter per-token cap for the compute-heavy MCP tools.

    Stacked on top of :class:`McpTokenReadThrottle` for the four tools whose read
    triggers a CPM + Monte Carlo recompute per call (whatif, monte-carlo/latest,
    forecast, sprint-forecast), so a token loop that could burn CPU is bounded
    well below the baseline read rate.
    """

    scope = "mcp_read_compute"
