# ADR-0207: Per-task schedule-shift event model

## Status
Accepted

> **ADR-number race note.** 0205 is reserved for #1080 (API rate limiting), 0206 for
> #1082 (webhook catalog expansion); parallel worktrees may also be claiming numbers.
> If 0207 collides at merge, renumber the later-merged ADR and repoint references —
> the standard renumber-at-merge drill.

## Context

Issue #413 (MR !979) extended `GET /projects/{id}/tasks/{task_id}/history/` with an
opt-in `?include=` parameter that merges comment, time-log, and attachment events
into a consistent `{event_type, actor, timestamp, detail}` activity feed. Three event
types named in #413's acceptance criteria were **deliberately skipped** because no
OSS per-task source model existed to back them:

- `cpm_recalculated` — the CPM writeback (`scheduling.tasks._run_schedule` /
  `_run_program_schedule`) persists `early_*` / `late_*` via `bulk_update`, which
  bypasses `VersionedModel.save()` and writes no `HistoricalTask` row (those fields
  are in `_HISTORY_EXCLUDED_TASK` by design — bumping `server_version` on every recalc
  would flood connected clients). A recompute therefore leaves **no per-task audit
  row**. `ScheduleRequest` is project-scoped; `TaskDurationChangeEvent.source` reserves
  `cpm_cascade` for duration cascades, not date shifts.
- `baseline_drift_detected` — computed on the fly in read views, never persisted.
- `risk_linked` / `risk_unlinked` — the `RiskTask` through-table carries no timestamp,
  no actor, and records no unlink.

**P3M layer**: a single task's activity within one project — team-scoped. **OSS.**
Cross-program / portfolio schedule forensics (the narrative "why did the whole program
slip") stays Enterprise.

## Decision

Add a single append-only per-task event model, `projects.TaskActivityEvent`, and wire
it into the existing feed:

- **Model.** Plain `models.Model` (not `VersionedModel`) — like
  `TaskDurationChangeEvent` and `ApiTokenAuditEntry`, these are audit rows, never synced
  to mobile, so no `server_version`. Fields: `task` FK (`CASCADE`), `actor` FK
  (`SET_NULL`, null for system events), `event_type` (`cpm_recalculated` |
  `baseline_drift_detected` | `risk_linked` | `risk_unlinked`), a `detail` JSON column
  (the feed row's `detail` verbatim — the CPM date deltas cannot be reconstructed at
  read time, so they must be persisted), and `created_at`. One index on
  `(task, -created_at)` serves the per-task newest-first read exactly.
- **Emit — CPM (`actor = null`).** In both writeback passes, snapshot each task's four
  CPM dates before the loop overwrites them; after the escalate guard, build one
  `cpm_recalculated` row per task whose dates actually moved and `bulk_create` them
  **inside the same `transaction.atomic()` block** as the writeback, so the audit rows
  commit or roll back with the dates they describe.
- **Emit — baseline drift (`actor = null`).** In the same pass, compare each task's new
  `early_finish` against its project's active baseline finish. Emit
  `baseline_drift_detected` **only on the transition into drift** (was within baseline,
  now past it), using the pre-overwrite `early_finish` as the "before" — so a
  persistently-drifted task does not re-fire every recalc. One extra indexed read for
  the active baseline's snapshot finishes; empty and cheap when no baseline is active.
- **Emit — risk link/unlink (`actor = member`).** In `RiskViewSet.perform_create` /
  `perform_update`, diff the linked-task set around `serializer.save()` and write a
  `risk_linked` / `risk_unlinked` row per added/removed task.
- **Surface.** Add two `?include=` tokens: `schedule` (→ `cpm_recalculated`,
  `baseline_drift_detected`) and `risks` (→ `risk_linked`, `risk_unlinked`). The
  no-`include` response stays byte-identical.

## Consequences

- The three #413 event types now have a real, citable source — an MCP/AI client can ask
  a task "when and why did your dates move" and get a server fact, not a guess.
- **Table growth is bounded by retention.** `cpm_recalculated` writes one row per moved
  task per recompute — on a converged schedule nothing moves, but an actively-edited
  large project can generate O(moved-tasks) rows per edit. To keep this bounded,
  `TaskActivityEvent` is registered in the ADR-0173 purge registry under
  `HISTORY_RETENTION_DAYS` (the same window as the diff history it sits beside in the
  feed), so the nightly purge ages the two sources out together and the table stays
  proportional to the retention window, not to total schedule churn. The index is
  `(task, event_type, -created_at)` so each `?include=` token's subset is a range scan
  even on a task dominated by `cpm_recalculated` rows.
- The emit sites add at most two queries to each CPM writeback (one baseline read, one
  bulk insert) and none to the common no-baseline, nothing-moved case.

## Alternatives considered

- **Reuse `TaskDurationChangeEvent`.** Rejected — it audits duration↔percent changes with
  a fixed column shape; overloading it with CPM date deltas, drift crossings, and risk
  links would blur two domains and force nullable columns that mean nothing for the other.
- **Store a `drifted` flag on `Task`.** Rejected — `Task` is a `VersionedModel`; a new
  synced field would ship a sync delta to every client on every crossing, the exact cost
  the CPM `server_version` carve-out exists to avoid.
- **Emit `cpm_recalculated` for every task every recompute (not just moved).** Rejected —
  noisy and unbounded; "the schedule moved this task" is the honest, self-limiting grain.

Relates #413, #1604, !979.

## Amendment (#1948) — per-project recalc summary on `cpm_recalculated`

Each `cpm_recalculated.detail` now additionally carries a per-project aggregate of the
recompute it belongs to, denormalized onto every moved task's row at emit time:

- `recalc_moved_count` — how many of that task's project's tasks moved in this pass (≥1);
- `recalc_finish` — the project's latest `early_finish` after the pass (ISO date, or null);
- `recalc_finish_delta_days` — signed day delta of that finish (`+N` slip later, `-N`
  pulled in, `0` unchanged, `null` when no prior finish exists — the first-ever recalc).

This adds **no new rows, no new table, and no correlation id** — the values ride the
existing per-task rows and all prior detail keys are retained for back-compat. A recalc
touches many tasks, but the per-task activity drawer only ever reads *one* task's events,
so a recalc-wide "N tasks moved" count cannot be reconstructed client-side; it must be
denormalized here. The aggregate is computed **strictly per `project_id`**: the emit helper
is shared by the program-scoped writeback, where `tasks_to_update` spans several member
projects in one call, so a single program-wide count would leak one project's schedule
scope onto another project's row — grouping per project keeps the OSS project-isolation
boundary intact. `baseline_drift_detected` is unchanged.
