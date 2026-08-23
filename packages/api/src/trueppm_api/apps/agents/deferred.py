"""Post-transaction delivery for refusal audit rows (#3017, ADR-0902).

``ATOMIC_REQUESTS = True`` wraps every view in a transaction, and DRF's
``exception_handler`` calls ``set_rollback()`` for **every** ``APIException``. So a
refusal audit written where the refusal is detected — inside ``finalize_response`` or
inside an authenticator — executes its INSERT and then has it discarded when the
request transaction rolls back. The measured effect (#3017) was an agent-action log
containing only successes: a 403 from an MCP guard and a 401 from a revoked token both
left zero rows, while the caller-facing refusal envelope worked fine. The half an
auditor reads was the half that was lost.

The fix is to move *when* the row is written, not *who* writes it.
:func:`queue_agent_action` stashes the fully-resolved kwargs on the request, and
:class:`~trueppm_api.apps.agents.middleware.AgentActionAuditMiddleware` drains the
queue on the way out. ``ATOMIC_REQUESTS`` wraps only the view callable
(``BaseHandler._get_response``), so by the time middleware processes the response the
request transaction has already committed or rolled back and the connection is back in
autocommit — a write issued there cannot be taken down with it.

Two properties this deliberately preserves:

**The chain stays single-writer.** ``record_agent_action`` is still the only writer and
still serializes on ``select_for_update`` over the singleton chain head. Deferring
changes the transaction the append runs in, not the lock that orders it, so two
requests draining concurrently interleave exactly as two inline appends would. This is
why the fix is a *timing* change rather than a second connection or an outbox worker,
either of which would have introduced a second writer to a hash-chained table.

**Refusal audits stay best-effort.** A refusal is already the safe outcome; a failed
audit write must never convert a 401/403 into a 500. Failures are logged and swallowed.
That is the inverse of the *allowed*-read path, which stays inline and fail-closed —
an allowed read must be atomic with its own audit, because serving data we could not
record is the outcome the substrate exists to prevent. The asymmetry is forced by the
transaction semantics, not a style choice: an allowed read has something to be atomic
with, and a refusal has nothing.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Request attribute holding the pending audit writes for this request.
#:
#: Underscore-prefixed to match the ``_trueppm_refusal`` / ``_mcp_scope_filtered``
#: convention for request-local markers set by one layer and read by another.
QUEUE_ATTR = "_trueppm_deferred_agent_actions"


def _host_request(request: Any) -> Any:
    """Resolve the underlying Django ``HttpRequest`` behind a DRF ``Request``.

    Producers run at different layers: the permission mixin holds a DRF ``Request``,
    the authenticator holds one too, and the middleware that drains the queue only ever
    sees the Django ``HttpRequest``. ``rest_framework.request.Request`` proxies attribute
    *reads* to ``_request`` but stores writes on itself, so queueing onto the DRF wrapper
    would put the list somewhere the middleware can never find it.
    """

    return getattr(request, "_request", request)


def queue_agent_action(request: Any, **kwargs: Any) -> None:
    """Queue one ``record_agent_action(**kwargs)`` to run after the request transaction.

    Every value must be resolved by the caller — the drain runs after the view has
    returned, so it must not depend on anything request-scoped that is torn down (or
    lazily re-evaluated) on the way out.
    """

    host = _host_request(request)
    queue = getattr(host, QUEUE_ATTR, None)
    if queue is None:
        queue = []
        setattr(host, QUEUE_ATTR, queue)
    queue.append(kwargs)


def drain_agent_actions(request: Any) -> int:
    """Write every queued audit row and return how many were recorded.

    Called by the middleware once the request transaction has closed. Each row gets its
    own attempt so one failure cannot silently drop the rest of the queue, and every
    failure is logged rather than raised — see the module docstring on why a refusal
    audit is best-effort.
    """

    host = _host_request(request)
    queue = getattr(host, QUEUE_ATTR, None)
    if not queue:
        return 0
    # Clear before writing so a re-entrant drain (or a middleware that calls the
    # response path twice) can never double-append to a hash chain.
    setattr(host, QUEUE_ATTR, [])

    from trueppm_api.apps.agents.services import record_agent_action

    written = 0
    for kwargs in queue:
        try:
            record_agent_action(**kwargs)
        except Exception:
            logger.warning("deferred agent-action audit failed", exc_info=True)
        else:
            written += 1
    return written
