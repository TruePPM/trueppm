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

#: Dispatched with ``sender=AgentAction``, ``action_id=<stringified UUID>`` and
#: ``action=<AgentAction instance>`` in the committing transaction's ``on_commit``.
#: Additive-only kwargs (ADR-0112 contract). New receivers should bind to ``action_id``
#: and re-read the durable row; ``action`` is DEPRECATED (#3807) and is retained only
#: until Enterprise has moved off it, then withdrawn in a coordinated, announced
#: release (step 2, still tracked by the open #3807).
#:
#: Rows of ``actor_kind="person"`` (#4814, ADR-0112 amendment of 2026-11-23) also reach
#: receivers: a person paused, resumed, re-scoped or revoked an agent. On those rows
#: ``actor_token`` is the agent acted on (not the caller's credential), ``principal`` is
#: its owner (``None`` when a project or program token is revoked, #5109),
#: ``capability_used`` is ``"agent:control"``, ``action`` is ``agent.pause`` /
#: ``agent.resume`` / ``agent.scope_edit`` / ``agent.revoke``, and the acting person is
#: named only in the hashed ``summary``. ``SCHEMA_VERSION`` is unchanged; a receiver must
#: branch on ``actor_kind`` rather than read every row as an agent's own action.
#: Revoke rows written without a request (the account-wide sweep, the ``revoke_api_tokens``
#: command) reach receivers with ``method=""`` and a ``payload_hash`` computed from a
#: revoke-facts dict rather than from a request.
agent_action_recorded = Signal()

#: The OSS legal-hold seam for chain-aware pruning (ADR-0361). Dispatched with plain
#: ``.send()`` **inside** the prune transaction, **before** the DELETE, carrying
#: ``cutoff_sequence``, ``cutoff_at``, and ``actor``. Any receiver that raises aborts the
#: whole atomic prune (fail-closed) — so Enterprise registers a legal-hold guard that
#: raises to block truncation of held rows, without OSS importing enterprise or forking
#: the purge. Community edition registers nobody and prunes unchanged. Additive-only
#: kwargs (ADR-0112 contract).
agent_action_prune_requested = Signal()
