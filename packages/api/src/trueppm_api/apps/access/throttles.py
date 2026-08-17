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
    """Base: throttle a request only when it is authenticated by an *agent* token.

    A non-token caller (human JWT/Session) yields ``None`` from
    :meth:`get_cache_key`, which DRF interprets as "skip this throttle entirely",
    so the baseline ``user``/scoped throttles remain the only bound on human
    traffic. An agent-token caller is bucketed on the token's own primary key.

    A ``legacy:full`` personal access token also yields ``None`` (#2877). These are
    *agent* budgets: ``mcp_read`` is 120/min and ``mcp_read_compute`` 12/min, against
    1000/min on the ``user`` scope a session gets. Metering a person's own CI script
    from the agent bucket capped it 8× tighter than the same person's browser — and
    since ``get_throttles`` is method-agnostic, once #2877 let that token write, its
    *writes* were being metered by a bucket named and sized for agent reads. Falling
    through to the ``user`` scope keeps it bounded and keeps the promise that a PAT is
    "governed exactly as your own session would be."
    """

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        # Local import: the model layer is not import-safe at settings-load time.
        from trueppm_api.apps.projects.models import is_agent_token

        token = getattr(request, "auth", None)
        if is_agent_token(token):
            return self.cache_format % {"scope": self.scope, "ident": str(token.pk)}
        return None  # human, or the owner's own full-access PAT — not an agent


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
