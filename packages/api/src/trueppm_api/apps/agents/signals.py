"""The OSS agent-action extension-point signal (ADR-0112 §1.3).

OSS dispatches ``agent_action_recorded`` inside the recording transaction's
``on_commit`` — so it fires exactly when (and only when) the action durably committed
and its chain link is written. In the community edition nothing is registered and the
signal dispatches to nobody; OSS runs unchanged. Enterprise registers a receiver at
app-ready to append to its immutable/notarized org trail, feed the approval-workflow
engine, and evaluate org capability policy (#146–#148). Enterprise reads the frozen
event; it never reaches into OSS internals.

The signal is kept dependency-free (a bare ``Signal``) so importing it never drags in
models — the receiver side lives entirely in the ``trueppm-enterprise`` repo.
"""

from __future__ import annotations

from django.dispatch import Signal

#: Dispatched with ``sender=AgentAction`` and ``action=<AgentAction instance>`` in the
#: committing transaction's ``on_commit``. Additive-only kwargs (ADR-0112 contract).
agent_action_recorded = Signal()

#: The OSS legal-hold seam for chain-aware pruning (ADR-0361). Dispatched with plain
#: ``.send()`` **inside** the prune transaction, **before** the DELETE, carrying
#: ``cutoff_sequence``, ``cutoff_at``, and ``actor``. Any receiver that raises aborts the
#: whole atomic prune (fail-closed) — so Enterprise registers a legal-hold guard that
#: raises to block truncation of held rows, without OSS importing enterprise or forking
#: the purge. Community edition registers nobody and prunes unchanged. Additive-only
#: kwargs (ADR-0112 contract).
agent_action_prune_requested = Signal()
