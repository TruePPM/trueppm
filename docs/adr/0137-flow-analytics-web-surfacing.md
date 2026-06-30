# ADR-0137: Flow-analytics web surfacing on the Kanban board

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: useFlowMetrics)

## Context
ADR-0130 (methodology-neutral flow analytics) shipped the backend in MR !619: a
`GET /projects/{pk}/flow-metrics/` endpoint, a per-column WIP breach verdict on the
board-config read, and a throughput-based delivery forecast threaded through the
existing sprint-forecast contract. None of it is surfaced in the web app. Worse, the
forecast change is a latent break: the shipped `sprint_forecast` service kept the
legacy `basis: "monte_carlo"` field but added a new `forecast_basis: "velocity" |
"throughput"` discriminator, a new `status: "insufficient_flow_history"`, plus
`remaining_count` and `p95_date`. The two web consumers of that contract
(`SprintForecastChips`, `SprintForecastWidget`) render `p50_sprints`/`p80_sprints`
unconditionally — which are **null** on the throughput path — so a continuous-flow
(kanban) team silently sees a broken "~null sprints" forecast today.

This ADR designs the frontend surfacing (issue #1188): the TS contract, a
`useFlowMetrics` hook, a collapsed-by-default flow-analytics panel on the board, a
per-column WIP breach chip, and the forecast-basis branching — all honoring the
ADR-0104 privacy ladder.

**Verified backend contract (read from the merged code, not the ADR-0130 text):**

```
flow-metrics:  { window_days, since, until,
                 cycle_time:{p50,p80,p95|null}, lead_time:{p50,p80,p95|null},
                 cfd:[{date, counts:{BACKLOG,NOT_STARTED,IN_PROGRESS,REVIEW,COMPLETE}}],
                 throughput:[{week_start, completed_count}],
                 data_integrity:{bulk_moved_count,backdated_count,missing_transition_count},
                 flow_metrics_suppressed }
sprint-forecast (additions): forecast_basis:"velocity"|"throughput" (discriminator),
                 remaining_count:number|null, p95_date:string|null,
                 status:"ready"|"warming_up"|"insufficient_flow_history".
                 basis stays the legacy "monte_carlo" constant.
board-config columns (additions): current_count:number, breach:"ok"|"at"|"over"|null.
```

`cycle_time`/`lead_time` are **percentile triples, not bucketed distributions** — the
"cycle-time distribution" surfaces as a compact P50/P80/P95 stat strip, not a histogram.

## Decision

**P3M layer: Programs and Projects / Operations — single-project, team-level
operational analytics. OSS.** The VoC panel confirmed the boundary: the on-target
agile cohort (Alex 9, Morgan 8, Jordan 7, Priya 6) champions it; the low off-target
scores (Janet, Marcus, Sarah, David) are the team-vs-portfolio line holding — there is
deliberately no cross-project rollup. A cross-project flow rollup would be Enterprise.

1. **TS contract.** Extend `SprintForecast` in `hooks/useSprints.ts` with
   `forecast_basis`, `remaining_count`, `p95_date`, and the `insufficient_flow_history`
   status. Add a `FlowMetrics` interface and a `useFlowMetrics(projectId, {window,
   enabled})` hook matching house style (`queryKey: ['project', id, 'flow-metrics',
   window]`, `apiClient.get`, `enabled: !!projectId`).

2. **Forecast-basis branching.** The discriminator is **`forecast_basis`**, not the
   legacy `basis`. Both paths are genuine Monte Carlo, so P50/P80/P95 vocabulary stays
   honest (web-rule 166) — the branch governs **units and language**, never whether
   percentiles appear:
   - `velocity`: sprint counts + points ("at this pace, the backlog clears in ~N
     sprints (P80 M)") — unchanged.
   - `throughput`: no sprint counts (null); item counts + dates ("at current
     throughput, ~`remaining_count` items clear by `p50_date` (P80 `p80_date`)"), with
     the basis labeled in visible text ("flow / throughput-based").
   - `insufficient_flow_history`: an explanatory warm-up state, not a blank widget
     (VoC Jordan/Alex) — "Throughput forecast needs ≥4 weeks of completed-work history."
   `SprintForecastChips` and `SprintForecastWidget` gain this branch.
   `VelocityForecastLine` is **not** touched — it consumes a different contract
   (`ProjectForecast.milestones` / `ForecastSnapshot.basis` = velocity_band|monte_carlo,
   web-rule 166) unrelated to `forecast_basis`.

3. **Flow-analytics panel.** A new `FlowAnalyticsPanel` mounts in `BoardView` between
   `SprintPanel` and the sticky column headers, **collapsed by default** (localStorage +
   `aria-expanded`, mirroring `SprintPanel`; addresses Priya's "collapsed-by-default").
   Charts reuse **Recharts** (already in `features/reports/BurnChart.tsx`; color tokens
   via CSS custom properties): a stacked-area **CFD**, a **weekly throughput** bar
   chart, and a compact **cycle/lead-time P50/P80/P95** stat strip. No new charting
   dependency. Cap render to the returned window.

4. **WIP breach chip.** The column header reads the server `breach` verdict +
   `current_count` from board-config (authoritative per ADR-0130 D2). A breach chip
   ("⚠ Over limit" / "At limit") renders whenever a limit is set and `breach` is
   `at`/`over` — **independent of the existing "Show WIP limits" toggle**, because a
   breach is a signal, not an opt-in detail (VoC Alex: "warn the team before the
   retro"). The numeric `N/limit` badge stays under the toggle. The current board-state
   counts are already visible on the board, so surfacing the verdict leaks nothing new
   (this is why D2 is ungated — confirms Morgan's gating question).

5. **Privacy / suppression rendering.**
   - `flow_metrics_suppressed === true` → the panel body renders a **content-free wall**
     (web-rule 165), matching `PulseGatedWall`: 🔒 + prose "This team keeps its flow
     metrics private…", no counts, no blur. `data_integrity` is zeroed by the backend
     under suppression and is not shown in the wall.
   - In-audience (not suppressed) → a legible privacy caption on the panel: "🔒
     Team-private · aggregate only — no individual breakdown" (VoC Morgan/Priya — make
     the guarantee self-evident, not doc-only).
   - Forecast **dates stay visible** even when the series is suppressed: the throughput
     forecast chip renders regardless of `flow_metrics_suppressed` (only the panel
     series are gated; `velocity_suppressed` independently gates the velocity path).

6. **New web-rule 176** (next free; 175 is the current max) in `packages/web/CLAUDE.md`
   codifying: `forecast_basis` is the branch discriminator (never the legacy `basis`);
   throughput forecasts use item/week/date vocabulary, never sprint/points; flow charts
   use Recharts with CSS-var tokens; `flow_metrics_suppressed` renders a content-free
   wall and in-audience panels carry the "aggregate only" caption.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Branch on legacy `basis` | one field | `basis` is frozen `"monte_carlo"` for both paths — cannot discriminate; wrong |
| Build bespoke SVG charts (like MonteCarloHistogram) | zero dep | Recharts already shipped (BurnChart); bespoke stacked-area/bar is needless reinvention |
| Histogram for cycle/lead time | richer | backend returns percentiles, not buckets — no histogram data exists |
| Always-on full panel | discoverable | violates Priya's friction line; board is dense — collapsed-by-default is correct |
| Gate the WIP breach chip behind the privacy ladder | symmetric | board-state counts are already visible; gating the derived verdict is security theater and hides an operational signal teams need |

## Consequences
- **Easier:** continuous-flow teams get a correct, non-broken delivery forecast and
  first-class flow metrics; the latent throughput-renders-as-null bug is fixed.
- **Harder:** two forecast vocabularies to keep honest; a new Recharts surface to test.
- **Risks:** (a) `forecast_basis` must be the sole discriminator — a stray `basis`
  comparison reintroduces the bug (web-rule 176 guards this); (b) Recharts color tokens
  must come from CSS vars (Tailwind can't reach SVG internals) — follow BurnChart; (c)
  the design-system-v2 hex gate counts `#NNNN` issue refs as hex — comments reference
  ADR-0137, never `#1188`.
- **Follow-ups (out of #1188 scope, file separately):** PO-facing backlog forecast card
  (Jordan), resource-level cross-board WIP rollup (David), trend sparkline on the WIP
  chip (Alex). A concrete "N more weeks needed" countdown on `insufficient_flow_history`
  is desirable but the contract exposes `sample_count` (non-zero weeks so far), not the
  threshold — surface "≥4 weeks" guidance from the known `MIN_THROUGHPUT_WEEKS`.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: web only
- Migration required: no
- API changes: no (consumes the ADR-0130 contract already on main)
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: **N/A** — frontend-only; consumes existing read endpoints, no async side effects, no `.delay()`.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — read-only; the backend `flow_metrics`/`sprint_forecast` services already exist (ADR-0130).
5. API response on best-effort dispatch: **N/A** — synchronous GET reads only.
6. Outbox cleanup: **N/A** — no outbox usage.
7. Idempotency: **N/A** — GET requests are nullipotent; TanStack Query caches by key.
8. Dead-letter / failure handling: **N/A** — on fetch error the hook surfaces `query.error`; the panel renders an inline error state, no retry queue.
