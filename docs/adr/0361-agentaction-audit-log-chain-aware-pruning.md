# ADR-0361: Chain-Aware Admin-Triggered Pruning of the AgentAction Audit Log

## Status
Proposed

Amends the retention posture stated in **ADR-0112** (§1.3, Durable Execution item 6)
and **ADR-0157** (§5) for the `AgentAction` chain. Does **not** modify the ADR-0173
retention-purge framework — see the Decision for why this feature deliberately stays
out of the automatic coordinator.

## Context

`AgentAction` (`apps/agents`, shipped in #1805 under ADR-0112 RC1/RC2) is an
append-only, per-instance **hash-chained** audit log of every MCP/agent read and
refusal. Each row carries a gap-free `sequence`, a `prev_hash`, and
`record_hash = sha256(prev_hash ‖ canonical(record))`; a singleton
`AgentActionChainHead` holds the frontier (`last_sequence`, `last_record_hash`) under
which `record_agent_action` appends via `select_for_update`. `manage.py audit_verify`
walks the chain **from `GENESIS_PREV_HASH` at sequence 1** and reports the first break.

**The problem (#1842).** It is the one operational table with **no retention lever**.
On any instance running MCP tokens it grows unbounded, and a manual `DELETE` breaks the
chain — `audit_verify` then correctly reports a break (the first surviving row's
`sequence != 1` and its `prev_hash != GENESIS_PREV_HASH`). Operators have no safe way to
bound the table.

**The boundary tension.** Three accepted ADRs assign *automatic* audit-log retention to
Enterprise:
- ADR-0112 §Durable-Execution item 6: rows are "never purged … purging one would break
  the hash chain"; retention policy is "the Enterprise value-add (#146)."
- ADR-0157 §5: "Automatic retention/purge is an Enterprise concern (ADR-0173 territory)
  and a guarantee OSS explicitly does not make (per #859) … **an admin-triggered prune
  can be added later without schema change**."
- ADR-0173 §Context: "audit-log retention row … is Enterprise (trueppm-enterprise#137)
  and is **not** built here."

ADR-0157 §5 is decisive: it distinguishes **automatic/enforced retention (Enterprise)**
from an **admin-triggered manual prune (OSS-addable)**. This ADR builds the latter.

**Positioning constraint (2026-07-11 hybrid-positioning doc).** The ADR-0112
hash-chained *team-readable* audit is the single **shipped, verifiable** AI-credibility
anchor ("lead the credibility claim with it"). Therefore: (a) OSS must **never silently
delete** audit history — pruning is opt-in and operator-initiated only; (b)
`audit_verify` must **still pass across a prune**.

**P3M layer:** Operations (instance data maintenance). **OSS.**

## Decision

Ship a **chain-aware, admin-triggered prune** entirely within `apps/agents` — a
`manage.py audit_prune` command backed by a `prune_agent_actions` service, plus a new
immutable **checkpoint** row that re-anchors verification, plus a checkpoint-aware
`audit_verify`. **No** wiring into the automatic ADR-0173 coordinator, `purge_registry`,
`RETENTION_SPECS`, or the System Health retention editor (those remain Enterprise
surfaces per ADR-0173 §Context).

### 1. Checkpoint model — new `AgentActionCheckpoint` (immutable)

A dedicated table, **not** folded into `AgentActionChainHead` (which tracks the forward
frontier and must not be conflated with the pruning floor, and cannot hold a *history*
of prunes) and **not** a synthetic `AgentAction` row (which would pollute audit
semantics and force `canonical_fields` to special-case a non-action).

```
AgentActionCheckpoint
  id                       UUIDField PK
  pruned_through_sequence  BigIntegerField  unique   # highest sequence deleted
  pruned_through_hash      CharField(64)             # record_hash of that last-deleted
                                                     # row = the re-anchor seed
  first_retained_sequence  BigIntegerField           # = pruned_through_sequence + 1
  pruned_count             BigIntegerField
  pruned_by                FK(AUTH_USER_MODEL, SET_NULL, null=True)  # who ran it
  created_at               DateTimeField             # set at write time
  Meta: db_table = "agents_agent_action_checkpoint"; ordering = ["pruned_through_sequence"]
```

The checkpoint is an **integrity-continuity** artifact, not compliance evidence. It is
deliberately **not** hash-chained to prior checkpoints in OSS: the surviving tail's
tamper-evidence does not depend on it (any edit to a retained row still fails its own
`record_hash` recompute), and OSS does not resist a fully-malicious admin — that is the
Enterprise notarized-archive guarantee (ADR-0112 §3). Chaining/notarizing the
checkpoints is an explicit Enterprise extension, not built here.

### 2. Concurrency — reuse the chain-head lock

`prune_agent_actions` runs one `transaction.atomic()` holding
`AgentActionChainHead.objects.select_for_update().get(pk=1)` — the same lock the writer
uses — for: read frontier → dispatch the pre-prune guard signal → compute cutoff → write
the checkpoint → `DELETE` the prefix. This serializes prune-vs-append and prune-vs-prune
with zero new lock primitives. Prune is a rare, manual, low-QPS maintenance action, so
the brief append-blocking is acceptable. The prune only ever touches **old** rows (lowest
sequences, far from the head); the head row itself is never deleted and is left untouched
(new appends continue to chain forward from `last_record_hash`).

### 3. Legal-hold seam — a pre-prune veto signal

New bare `Signal` in `apps/agents/signals.py`, mirroring the `agent_action_recorded`
precedent:

```python
agent_action_prune_requested = Signal()  # kwargs: cutoff_sequence, cutoff_at, actor
```

Dispatched with plain `.send()` (not `send_robust`) **inside** the prune transaction,
**before** the `DELETE`. Any receiver that raises aborts the whole atomic prune
(fail-closed). OSS registers no receiver. **Enterprise registers a legal-hold guard**
that raises to block truncation of held rows — no OSS-internal coupling, additive-only
kwargs, a cross-repo contract under the same stability rule as `agent_action_recorded`.

### 4. Window semantics — explicit CLI args, dry-run by default

`manage.py audit_prune` is purely argument-driven (no `settings.*` default, no editor
row — keeping it unambiguously *not* an automatic ADR-0173 retention window):

- `--before <ISO-8601>` — delete rows with `occurred_at < before`
- `--keep-days <N>` — sugar for `--before now()-N days`
- `--keep-last <K>` — keep the newest K rows, delete the rest (count-based)
- `--commit` — **required to actually delete; without it the command is a dry-run**
  and only reports the eligible count and the resulting checkpoint anchor.
- `--yes` — skip the interactive confirmation on `--commit`.

Exactly one of `--before` / `--keep-days` / `--keep-last` is required. Dry-run-by-default
plus a required explicit window means the command can never silently or accidentally
delete audit history (positioning constraint (a)).

An operator who wants automation crons this command themselves — an OSS operator
operating their own instance. OSS ships **no Beat schedule** for it; automatic/enforced
scheduling is the Enterprise layer.

### 5. `audit_verify` — seed from the latest checkpoint

Replace the two hard-coded genesis seeds with a checkpoint lookup; `canonical.py` (the
single hash source) is untouched.

```
latest = AgentActionCheckpoint.objects.order_by("-pruned_through_sequence").first()
if latest is None:
    expected_prev, expected_sequence = GENESIS_PREV_HASH, 1
else:
    expected_prev, expected_sequence = latest.pruned_through_hash,
                                       latest.first_retained_sequence
for action in AgentAction.objects.order_by("sequence").iterator():
    ... # unchanged per-row checks
```

Added invariant: the lowest surviving `sequence` must equal
`latest.first_retained_sequence` (a deletion without a matching checkpoint, or a forged
checkpoint, therefore still shows up as a break). The command reports which anchor it
seeded from ("verifying N rows from checkpoint @seq X" vs "from genesis"). Positioning
constraint (b) is satisfied and tested.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Admin-triggered `audit_prune` + checkpoint (chosen)** | Honors ADR-0157 §5's explicit OSS carve-out; zero automatic deletion (positioning-safe); observability/ADR-0173 untouched; small, self-contained MR | New command + model; operator must run/cron it |
| B. 7th spec in the ADR-0173 auto-coordinator (the issue's original framing) | "Free" UI + scheduling; symmetric with the other 6 tables | **Rejected — contradicts ADR-0112 item 6, ADR-0157 §5, and ADR-0173 §Context** (automatic audit-log retention is Enterprise); automatic Beat deletion violates positioning constraint (a) |
| C. Fold anchor into `AgentActionChainHead` | No new table | Conflates forward frontier with pruning floor; can't hold prune history; singleton can't represent multiple prunes |
| D. Synthetic `AgentAction` "checkpoint row" | No new table | Must satisfy the chain's own hash invariants; pollutes audit semantics; forces `canonical_fields` special-casing |
| E. Chain the checkpoints (hash-linked) | Marginal extra tamper-evidence on the floor | Unneeded for the OSS guarantee (surviving tail is self-verifying); notarization is the Enterprise value-add — over-builds OSS |

## Consequences

- **Easier:** operators can bound the table safely; the "verifiable" credibility claim
  survives pruning; Enterprise plugs legal-hold in through a stable signal.
- **Harder:** `audit_verify` gains a checkpoint lookup (still single-source via
  `canonical.py`); a second concept (the floor) now exists alongside the head.
- **Risks:** (1) an operator running `--commit` deletes irreversibly — mitigated by
  dry-run default + required explicit window + confirmation. (2) A malicious admin can
  still prune-and-forge; this is the known OSS limit (ADR-0112 §3) and the Enterprise
  conversion line — documented, not solved here. (3) `--keep-last` on an actively-written
  chain computes the cutoff under the head lock, so the count is consistent at prune time.

## Implementation Notes

- **P3M layer:** Operations. **OSS** (`trueppm-suite`).
- **Affected packages:** `api` only (`apps/agents`: models, migration, `services.py`,
  `signals.py`, `management/commands/audit_prune.py`, `management/commands/audit_verify.py`).
  **No** `apps/observability` changes. **No** `web` changes.
- **Migration required:** yes — one migration creating `AgentActionCheckpoint` (pure
  `CreateModel`, no data migration, no change to `AgentAction`).
- **API changes:** none (no new endpoint; the existing team-readable
  `GET /api/v1/agent-actions/` is unaffected).
- **OSS or Enterprise:** OSS. Enterprise (`trueppm-enterprise`, post-1.0) adds: enforced
  retention, the legal-hold guard on `agent_action_prune_requested`, and the off-server
  WORM/notarized archive that makes local pruning lossless.

### Durable Execution
1. **Broker-down behaviour:** N/A — `audit_prune` is a synchronous management command in
   one DB transaction; no `.delay()`, no async side effects.
2. **Drain task:** N/A — no async dispatch.
3. **Orphan window:** N/A — no `on_commit` async work; the pre-prune signal fires
   synchronously inside the transaction.
4. **Service layer:** new `apps/agents/services.py::prune_agent_actions(*, before=None,
   keep_days=None, keep_last=None, commit=False, actor=None) -> PruneResult`; the command
   is a thin wrapper.
5. **API response on best-effort dispatch:** N/A — CLI command, synchronous result.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** naturally idempotent — re-running with the same window deletes
   same-or-fewer rows; a checkpoint is written **only when rows are actually deleted**
   (cutoff advances the floor), so a no-op prune writes no redundant checkpoint. The
   `select_for_update` on the head serializes concurrent invocations.
8. **Dead-letter / failure handling:** N/A — any exception (including a legal-hold
   receiver raising) rolls back the whole atomic prune; nothing is partially deleted and
   no checkpoint is written. The command exits non-zero and reports the reason.
