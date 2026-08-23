"""Drain the deferred agent-action audit queue after the request transaction (#3017).

See :mod:`trueppm_api.apps.agents.deferred` for why the write has to happen here and
not where the refusal is detected.
"""

from __future__ import annotations

from collections.abc import Callable

from django.http import HttpRequest, HttpResponse

from trueppm_api.apps.agents.deferred import drain_agent_actions


class AgentActionAuditMiddleware:
    """Write queued agent-action audit rows once the view's transaction has closed.

    ``ATOMIC_REQUESTS`` wraps only the view callable, so on the response path the
    connection is back in autocommit and ``record_agent_action``'s own
    ``transaction.atomic()`` opens a fresh transaction that commits independently of
    whatever the request did. That is the whole mechanism: a row written here survives
    the ``set_rollback()`` DRF performs for every refusal.

    Placed **last** in ``MIDDLEWARE`` so its response half runs first on the way out —
    as close to the view as a middleware can get, which keeps the audit row's
    ``occurred_at`` honest and writes it while the request's DB connection is
    certainly still open.

    The drain is in a ``finally`` so a middleware below raising cannot strand the
    queue. It is deliberately **not** ``async_capable``: ``record_agent_action`` does
    blocking ORM work, and leaving this sync lets Django run it in the same threadpool
    context it already uses for :class:`~trueppm_api.core.middleware.RejectNullBytesMiddleware`
    rather than inviting a DB call onto the event loop.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        try:
            return self.get_response(request)
        finally:
            drain_agent_actions(request)
