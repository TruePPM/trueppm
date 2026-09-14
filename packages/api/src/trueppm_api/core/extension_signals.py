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

The ``sender`` convention
-------------------------

**``sender`` is the OSS model class the signal is about, or ``None`` when the
signal is not about a model row. Never a string, never an instance.** (#3777)

Django's dispatcher filters receivers on ``sender`` *identity*, and it has no
notion of a wrong one: a receiver registered against a sender that never
arrives simply does not run. There is no error, no warning, and nothing on the
Enterprise side that could notice. Before this rule was written down, ten sites
passed a model class and six passed a string (``type(task).__name__``,
``task_name``), so ``@receiver(celery_task_started, sender=RecalculateScheduleTask)``
was silently dead code — which is why the form is fixed here rather than left to
each call site.

``None`` is the honest value where no model class exists. The five Celery-bridge
signals are the only such family: they are about a *worker run*, not a row, and
the terminal one (``celery_task_permanently_failed``) is dispatched from the
dead-letter recorder, which has the task's **name** and no task object at all —
so the family could not supply a class uniformly even if one were wanted. Their
discriminator is the ``task_name`` kwarg, present in every one of their
payloads; a receiver connects without a sender filter and branches on it.

The ``**kwargs`` convention
---------------------------

**Identifiers and plain scalars by default. A model instance only on a signal
dispatched inline — never on one dispatched from ``transaction.on_commit()``.**

An id is the looser coupling: Enterprise binds to a UUID rather than to the
shape of an OSS model, and the payload survives an OSS model refactor. But
"always ids" is wrong here, because the two dispatch timings give a receiver
different things to work with, and ``ATOMIC_REQUESTS`` is on:

- **Dispatched from** ``transaction.on_commit()`` — the row is durable, so a
  receiver can fetch exactly the fields it needs by id. Pass identifiers
  (``project_id``, ``milestone_id``, …), stringified UUIDs, and scalars.
  ``milestone_forecast_recomputed``, ``team_signal_consent_changed`` and
  ``team_signal_ceiling_proposal_changed`` are the model.
- **Dispatched inline**, inside the transaction that produced the row — the row
  is *not* durable and may still roll back, and a receiver that re-read it by id
  would be reading uncommitted state through the same connection. Here the
  instance the sender hands over is the only safe form, and it is a **read-only
  snapshot**: a receiver must not save it, and must defer any I/O with
  ``transaction.on_commit()``. ``task_status_changed``, ``risk_changed``,
  ``sprint_scope_changed`` and ``history_record_created`` are the model.

Two signals predate the rule and violate it: ``agent_action_recorded``
(``action=``) and ``audit_event_created`` (``audit_event=``) both fire from
``on_commit`` carrying an instance. Their own declarations pin them as
additive-only (ADR-0112) and "payload schema is STABLE" (ADR-0157), so the
instance kwarg cannot be withdrawn on this side of an Enterprise-coordinated
window; #3807 tracks adding the id sibling and retiring the instance. Do not
copy them.
"""

from __future__ import annotations

import logging
from typing import Any

from django.dispatch import Signal

logger = logging.getLogger(__name__)


def dispatch_extension_signal(signal: Signal, *, sender: type[Any] | None, **kwargs: Any) -> None:
    """Fire an OSS→Enterprise extension signal without letting a receiver break OSS.

    Args:
        signal: The extension-point ``Signal`` to fire.
        sender: The OSS model class the signal is about, or ``None`` when the
            signal is not about a model row. Never a string and never an
            instance — see the module docstring for why the form is fixed.
        **kwargs: The signal's declared payload. Identifiers and scalars, except
            on a signal dispatched inline; see the module docstring.

    Note:
        Never raises on a receiver's behalf. A receiver that fails is logged at
        ``exception`` level and the remaining receivers still run — that is
        ``send_robust``'s guarantee, and it is what keeps a third-party bug from
        becoming an OSS outage.

        A ``sender`` that breaks the convention is logged and then dispatched
        anyway, deliberately. Raising here would give a dispatch-site bug the
        power to break the OSS write path that fired the signal, which is the
        exact property this helper exists to protect — a contract violation must
        not be more destructive than the receiver failures it guards against.
        The enforcement that actually stops one reaching main is static and runs
        before the code does: ``mypy --strict`` rejects a non-class at the call
        site, and ``scripts/check-extension-signals.sh`` re-checks the *shape* of
        every ``sender=`` expression, catching the ``Any``-typed cases mypy is
        blind to.

        Do **not** use this for a fail-closed veto signal, where a raising
        receiver is the mechanism rather than a fault.
    """
    if sender is not None and not isinstance(sender, type):
        # Logged, not raised: see the Note above. This is unreachable from a
        # tree that passes the static gates, so a line here means one was
        # bypassed — say so loudly enough to be greppable.
        logger.error(
            "Extension-signal sender breaks the convention (#3777): "
            "expected a model class or None, got %r (%s). Receivers registered "
            "against a class will not fire for this dispatch.",
            sender,
            type(sender).__name__,
        )
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
