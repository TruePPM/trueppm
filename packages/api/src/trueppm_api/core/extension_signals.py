"""Dispatch helper for the OSS→Enterprise extension signals.

The Apache 2.0 boundary is one-way: enterprise registers receivers against OSS
extension points, and OSS knows nothing about enterprise. That contract only
holds if a receiver *cannot* affect the OSS write path that fired it — which is
a property of how the signal is sent, not of how it is declared.

``Signal.send()`` propagates a receiver's exception to the sender. On a signal
wired to a model's ``post_save``, that means a bug in enterprise code fails the
OSS save. ``history_record_created`` is fired from the ``post_save`` of the
``Historical*`` models for Project, Task and Dependency, so a raising receiver
there breaks **every task save in the product** — not one feature (#2606).

``send_robust()`` is the correct primitive: it collects each receiver's
exception into its return value instead of raising. But it swallows silently,
and a receiver that has been failing for a week with nothing in the log is its
own kind of defect — one call site's docstring already claimed the failures were
"swallowed-and-logged" when nothing logged them. This helper is the pairing:
robust dispatch, and every receiver failure recorded with enough context to
identify which receiver, on which signal, from which sender.

**The exception is a signal that is deliberately fail-closed.** A veto — a
receiver that raises to *stop* the operation, like the ``agent_action_prune_requested``
legal-hold check — must keep using ``send()``. Making it robust would let the
operation proceed past a hold that failed to register, inverting the safety
property. Those sites are annotated in place; see
``scripts/check-extension-signals.sh``, which enforces this helper everywhere else.
"""

from __future__ import annotations

import logging
from typing import Any

from django.dispatch import Signal

logger = logging.getLogger(__name__)


def dispatch_extension_signal(signal: Signal, *, sender: Any, **kwargs: Any) -> None:
    """Fire an OSS→Enterprise extension signal without letting a receiver break OSS.

    Args:
        signal: The extension-point ``Signal`` to fire.
        sender: The ``sender`` argument for the signal, as the signal's contract
            documents it (usually the model class).
        **kwargs: The signal's declared payload.

    Note:
        Never raises on a receiver's behalf. A receiver that fails is logged at
        ``exception`` level and the remaining receivers still run — that is
        ``send_robust``'s guarantee, and it is what keeps a third-party bug from
        becoming an OSS outage.

        Do **not** use this for a fail-closed veto signal, where a raising
        receiver is the mechanism rather than a fault.
    """
    for receiver, response in signal.send_robust(sender=sender, **kwargs):
        if isinstance(response, Exception):
            # exc_info explicitly: send_robust hands back the exception object
            # rather than re-raising, so there is no active exception for
            # logger.exception() to pick up from context.
            logger.error(
                "Extension-signal receiver failed: receiver=%s sender=%s",
                getattr(receiver, "__qualname__", repr(receiver)),
                getattr(sender, "__name__", repr(sender)),
                exc_info=response,
            )
