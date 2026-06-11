# ADR-0115: Board phase progress rollup defers to the ADR-0108 summary-task rollup

## Status
Accepted

## Context
Epic #986 ("API-first completeness") requires every domain value the UI shows to be a
first-class server fact so a headless/MCP client can read it without re-implementing web
logic. Issue #991 targets the board's per-phase progress rollup: `BoardView.tsx`
(`avgProgress()`) currently computes a per-phase mean of `percent_complete` across the
phase's *committed leaf tasks* in the browser, and `LaneMeta` sums per-phase
`budget_at_completion` / `actual_cost`.

Two facts decide this:

1. **A board "phase" is a WBS L1 summary task.** `buildPhases()` groups leaf tasks under
   their parent summary task (`phase.summaryTask`); the synthetic "Project Tasks" lane
   (id `root`) is the only phase with no backing summary task — it collects tasks that
   have no phase parent.
2. **Summary tasks already expose a server-owned progress rollup.** Per ADR-0108,
   `TaskViewSet` annotates a delivery-mode-weighted `percent_complete_rollup` and
   `TaskSerializer.to_representation` overrides `percent_complete` with it. That value is
   already MCP-reachable on every summary task.

So the board's phase progress is *already* a server field — via the phase's summary task —
except the board derives its own simpler number (an unweighted committed-leaf mean) that
disagrees with the ADR-0108 rollup and with the same summary task's progress as shown in
the Gantt.

The cost half (`budget_at_completion`, `actual_cost`) cannot ship: there is no cost model
(`TODO(#73)`), mirroring #990 which shipped SPI and deferred CPI.

P3M layer: Programs and Projects (single project board). OSS.

## Decision
**Path (b): the board reads the existing ADR-0108 summary-task `percent_complete` instead
of computing its own mean. No new endpoint is added.**

- For any phase backed by a summary task, `BoardView`/`LaneMeta` render
  `phase.summaryTask.percent_complete` (the ADR-0108 weighted rollup) — the same number
  the Gantt shows for that summary task.
- The synthetic "Project Tasks" root lane has no backing entity and therefore no server
  rollup. Its progress chip is dropped (it was a UI-only grouping, never a domain object;
  there is nothing for an MCP client to read because there is no "root phase" resource).
  This avoids inventing a phantom aggregate for a non-entity.
- **Cost rollups are omitted now**, not faked. A `TODO(#73)` marker and follow-up issue
  track the BAC/actual cost-rollup dimension; it lands when the cost model ships
  (overlaps #408). The board's existing cost chips that read never-populated fields are
  removed alongside the #990 dead-CPI-chip cleanup.

This resolves the #991 fork and removes a second, divergent definition of phase progress.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| (a) New `board/phase rollup` endpoint computing the committed-leaf mean | Preserves the board's exact current number | Adds API surface + an N-phases query for a value that already exists; entrenches a *second* progress definition that disagrees with the Gantt/summary task; more to keep consistent |
| **(b) Defer to ADR-0108 summary-task rollup (chosen)** | Zero new API surface; one progress definition everywhere; already MCP-reachable; delivery-mode-aware (more correct) | The displayed phase % changes (weighted rollup ≠ unweighted committed mean); root lane loses its progress chip |
| (c) Keep client-side mean | No change | Violates the #986 contract; strands the value from MCP |

The displayed-number change under (b) is an accuracy improvement, not a regression: the
weighted, delivery-mode-aware rollup is the project's canonical progress definition and is
already what the same phase shows in the Gantt.

## Consequences
- **Easier**: one progress number per phase across board + Gantt; nothing new to maintain
  server-side; the board card stops drifting from the summary task.
- **Harder**: the board phase % visibly changes for mixed-weight phases; covered by a
  changelog `changed` note. The root lane's progress chip is removed.
- **Risk**: low — relies entirely on an already-shipped, already-tested computed field.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web (BoardView/LaneMeta consume `summaryTask.percent_complete`),
  api (no change for #991 progress; cost deferred to #73)
- Migration required: no
- API changes: no new endpoint for #991. Sibling #992 adds two computed read fields to
  `TaskSerializer` — `is_stalled` (bool verdict: `status_changed_at` older than 3 days AND
  `percent_complete < 100`; `false`/null when `status_changed_at` is null or
  `percent_complete >= 100`) and `dwell_days` (int: days since `status_changed_at`, the
  raw fact). This mirrors the `spi` (fact) + `spi_band` (verdict) precedent: expose the
  underlying fact *and* the server's verdict so an MCP client can re-threshold. Both are
  `SerializerMethodField`s — no model change, no migration.
- OSS or Enterprise: OSS (single-project board phase rollup; cross-program/portfolio
  rollups remain Enterprise).

### Durable Execution
1. Broker-down behaviour: N/A — pure read fields and read-time consumption; no async dispatch.
2. Drain task: N/A — no async work.
3. Orphan window: N/A.
4. Service layer: N/A — `percent_complete` rollup already lives in the TaskViewSet
   annotation (ADR-0108); `is_stalled`/`dwell_days` are pure serializer computations.
5. API response on best-effort dispatch: N/A — synchronous reads only.
6. Outbox cleanup: N/A.
7. Idempotency: N/A — reads are naturally idempotent.
8. Dead-letter / failure handling: N/A.
