# ADR-0035: Board Batch 3 — PPM Signals on Cards (Deps, Overalloc, Milestones, Risks, Keyboard)

## Status
Accepted

## Context

Wave 2 board work has shipped batches b1 (lane meta + column tints + density) and
b2 (collapse hints + responsive density + float chip + baseline variance + card aging).
Ten issues remain on the `wave/2-board` label. Batch 3 (this ADR) groups five of
them that turn the board into a true PPM intelligence surface — predecessors,
overallocation, milestones, risks, and keyboard navigation — without requiring
new persistence layers or evaluative engines (cost, EVM, P80 store).

Voice-of-Customer panel (2026-04-27, second session) scored the batch 7.4/10 across
the five personas with explicit hero features for Priya (keyboard, 9/10), David
(overalloc, 9/10), Sarah (milestones, 8/10), and Marcus (risk linkage, 7/10). Janet
(COO) is correctly indifferent — this is a Programs/Projects layer batch.

Five blocking design questions were raised by VoC and require ADR-level decisions
before implementation can begin:

1. Overallocation calc — naive per-assignment proxy vs. real per-day daily-sum
2. Risk severity color mapping — no stored severity field; computed `probability × impact`
3. Shared keyboard shortcut registry — `d` from #182 vs. full nav from #195
4. Milestone rail layout — date-pinned (no time axis exists) vs. status-pinned
5. SPI/CPI deferral hygiene — must not slip silently

The remaining five wave-2 issues (#185 SPI/CPI, #196 P80 distribution, #189 cost
burn, #191 saved views, #170 configurable columns) are deferred to b4+ because
each requires a dependency that doesn't exist yet (EVM API, MC result store,
cost model, or persistence layer). #170 partially exists already (ADR-0013
amendment introduced `BoardColumnConfig`) — what remains is the editor UI.

## Decision

### Q1 — Overallocation calc (#184)

**Decision:** Use the existing `/projects/{id}/resource-allocation/` endpoint with
the existing `detectOverallocatedAssignments()` helper for per-day units summation
across the card's date window. **Do NOT add a per-assignment `units > 1.0` proxy.**

**Honest scope, documented in tooltip and feature docs:**
- Calc treats all weekdays as working days (`max_units` is daily capacity); it does
  NOT apply per-resource calendar exceptions. CalendarException-aware allocation is
  a separate concern (ADR-0031 leaves the calendar overlay to the utilization
  endpoint, not allocation). Calling out this limitation explicitly avoids the
  "1.4× during a vacation week" false positive that would erode user trust.
- Threshold is configurable via a new `BoardConfig.overalloc_threshold` field
  (default 1.0); for b3 this lives in localStorage as `board:overallocThreshold`
  and is per-user, not per-project. Persistence is deferred until #170/#191 add
  the BoardConfig editor.
- Click-through opens the existing resource histogram drawer
  (`/resources/{id}?week=YYYY-Www`) rather than a new modal.

**Rationale:** ADR-0031 already chose client-side aggregation as the canonical
overallocation pattern; the helper is tested and used in the resource timeline.
Building a parallel per-assignment proxy would violate the "single source of
truth for overallocation" principle and produce inconsistent results between
the board and the timeline. The calendar gap is a known limitation, not a new
one — surface it in the UI rather than hide it.

### Q2 — Risk severity color (#188)

**Decision:** Severity is `Risk.probability × Risk.impact` (range 1–25, no stored
field). Card icon color is keyed to the **highest severity among linked risks**.
RAG mapping:

| Severity range | RAG | Token | Used elsewhere |
|---------------|-----|-------|----------------|
| 1–6 | Green | `semantic-good-fg` | Low likelihood × low impact |
| 7–14 | Amber | `semantic-warn-fg` | Watch list |
| 15–25 | Red | `semantic-bad-fg` | Critical / actively mitigating |

The bands match the 5×5 P×I matrix conventional cutpoints (low/medium/high tertile
on the 25-cell grid). Backend exposes `linked_risks_max_severity` as a queryset
annotation (`Max(probability × impact)` on `tasks__risks`). No new endpoint —
existing `RiskViewSet.get_queryset` already annotates per-risk severity; we add
a per-task aggregate.

**Click-through:** Opens a new lightweight `RiskPopover` (component, not page)
listing linked risks with title, status pill, and computed severity; "Open in
register" link routes to `/projects/{id}/risks?focus={risk_id}`. The popover
reuses the `BadgePopover` pattern from shell (no new library).

### Q3 — Shared keyboard registry (#182 + #195)

**Decision:** A single `useBoardKeyboard()` hook owns all board-scoped shortcuts.
Hook is mounted at `BoardView` level and exposes:

```ts
useBoardKeyboard({
  onMoveFocus: (dir: 'up'|'down'|'left'|'right') => void,  // J/K/H/L + arrows
  onOpen: () => void,        // Enter
  onEdit: () => void,        // e
  onDeps: () => void,        // d  ← #182 wires here
  onComments: () => void,    // c
  onCheatsheet: () => void,  // ?
})
```

- Focus state lives in `BoardView` as `focusedCardId: string | null` plus
  `focusedColumn: TaskStatus | null` for column traversal.
- `BoardCard` reads `isFocused` via prop (not via DOM `document.activeElement`)
  to keep React-controlled focus stable across re-renders.
- Shortcuts are suppressed when an input/textarea/contenteditable is focused
  (standard `event.target instanceof HTMLInputElement` guard).
- `?` opens a `KeyboardCheatsheet` modal with all bindings; Esc closes.
- Focus ring uses `focus-visible:ring-2 focus-visible:ring-brand-primary
  focus-visible:ring-offset-2` (existing token; meets WCAG AA contrast 3:1
  against neutral surface).

**Rationale:** Two parallel keyboard systems would race on the same key events
(`d` would fire both #182 popover and any other registered handler). One registry
keeps event handling deterministic and makes future additions (#191 saved views
filter, etc.) trivial.

### Q4 — Milestone rail layout (#187)

**Decision:** Diamonds are **pinned to the status column** of their parent milestone
task, NOT date-positioned. The board has no horizontal date axis — milestones
appear in the column whose `TaskStatus` matches `Task.status` for the milestone
task. Hover reveals target date.

Specifically:
- New `PhaseMilestoneRail` component renders as a 24px-tall row above each
  `PhaseLane` (only when `is_milestone` tasks exist in that phase).
- For each milestone task: render a 12px diamond (`◆`) inside the corresponding
  `BoardCell` slot (one diamond per status column).
- Color from `Task.status` + `Task.actual_finish` vs. `Task.planned_start`:
  - **Green** — `status === COMPLETE` and `actual_finish <= planned_start` (hit)
  - **Red** — `status !== COMPLETE` and `today > planned_start` (missed)
  - **Red** — `status === COMPLETE` and `actual_finish > planned_start` (late hit)
  - **Neutral** — otherwise (upcoming / on-track)
- Hover popover: name + target date + status pill.
- Click: opens task drawer (existing pattern, focus the milestone task).
- Keyboard reachable via Tab once focus enters the rail; Enter opens drawer.

**Rationale:** The board's spatial language is status-column-based, not
time-based. Forcing a synthetic time axis on top would break the mental model
and conflict with the existing column tints. Status-pinning preserves the
"where in flow is this milestone" signal without inventing new geometry.

### Q5 — SPI/CPI deferral (#185)

**Decision:** Document deferral explicitly. The required preconditions are:
- API: `Task.actual_cost`, `Task.planned_cost` (or accumulator on Resource × time)
- API: serializer field `evm: { ev, pv, ac, spi, cpi }` computed at request time
- Out of scope for b3; tracked in a new dependency note on issue #185 referencing
  this ADR section.

When #185 is picked up, the SPI/CPI chip plugs into the same `BoardCard`
indicator strip used for the float chip and risk icon — no new layout work
needed downstream.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **#184 — naive `units > 1.0` proxy** | Zero backend, no extra fetch | Wrong answer in the canonical case (cross-task double-booking); user trust loss when board says 1.0× and timeline says 1.6× |
| **#184 — server-side overalloc flag in TaskSerializer** | Single-shot board fetch | Re-implements ADR-0031 logic on the API side; perf cost on every list call; calendar awareness still missing |
| **#188 — store severity field** | Avoids recomputation | Requires a migration + backfill + risk of staleness when probability/impact change; computed is fine for a small enum |
| **#188 — flat amber dot regardless of severity** | Simpler | Marcus's hero feature is RAG signal — flat color defeats the purpose |
| **#187 — date-pinned diamond rail** | "Real" timeline visual | Board has no date axis; would require a synthetic one and break swimlane geometry |
| **#187 — diamond on the milestone card itself** | No new component | Milestones lose visibility once card scrolls; rail keeps them sticky at lane top |
| **#195 — per-component handlers** | Locality | Breaks shortcut conflicts; #182's `d` and #195's `d` would collide |
| **#195 — full a11y library (react-aria)** | Industry-standard a11y | New dependency; we only need ~7 shortcuts |

## Consequences

### Easier
- One source of truth for overallocation → board and timeline match.
- Risk linkage closes the visibility gap between Risk Register and active work.
- Keyboard parity with Jira/Linear unlocks Priya as a daily user of the board.
- Future shortcuts (#191 view picker, #170 column editor) plug into the same registry.

### Harder
- Frontend now fetches both task list AND `/resource-allocation/` on board mount
  (already done for the timeline view; we share the query). Overalloc badges
  appear progressively; cards render without them on initial paint.
- New `RiskPopover` and `DepPopover` components add ~3 KB gzip to the board bundle.
- Keyboard navigation must coexist with @dnd-kit's `KeyboardSensor`. Conflict
  resolution: card drag is initiated via Space (dnd-kit default); J/K/H/L move
  focus only. Document this in the cheatsheet to avoid user surprise.

### Risks
- **Perf**: Adding `predecessor_count`, `is_blocked`, `linked_risks_count`,
  `linked_risks_max_severity` to `TaskViewSet.get_queryset()` annotations
  produces 4 new subqueries per row. Mitigation: composite annotation using
  `Exists` (boolean) for `is_blocked` and `Count` for `predecessor_count` is
  acceptable at typical board sizes (≤500 tasks). `perf-check` agent must
  verify with EXPLAIN ANALYZE before merge. If row count exceeds 500, fold
  into a single CTE or move risk/dep counts to a `task-meta` companion endpoint.
- **Calendar gap on #184**: Documented honest limitation; if user feedback shows
  it generates false positives, follow-up is to apply CalendarException to the
  allocation endpoint (separate ADR).
- **Diamond rail visibility**: If a phase has many milestones in the same status
  column, diamonds pile up. Mitigation: cap visible at 5 with a "+N more" pill
  that opens a milestone list popover.

## Implementation Notes

### P3M Layer
**Programs and Projects** — single project, board view, no cross-project rollup.
Stays OSS. Risk linkage references existing `RiskTask` join (also OSS).

### Affected packages
`api`, `web`. No scheduler changes. No mobile changes (board is web-only).
No helm changes.

### Migration required
**No** — all four new fields on TaskSerializer are queryset annotations (`Exists`,
`Count`, `Max`), not stored model fields. No schema change.

### API changes
1. `TaskViewSet.get_queryset()` adds:
   - `predecessor_count` — `Count("predecessors", filter=Q(predecessors__is_deleted=False))`
   - `is_blocked` — `Exists(Dependency.objects.filter(successor=OuterRef("pk"), is_deleted=False).exclude(predecessor__status=TaskStatus.COMPLETE))`
   - `linked_risks_count` — `Count("riskthrough", filter=Q(riskthrough__risk__is_deleted=False, riskthrough__risk__status__in=ACTIVE_RISK_STATUSES))`
   - `linked_risks_max_severity` — annotated `Max(F("riskthrough__risk__probability") * F("riskthrough__risk__impact"))`
2. `TaskSerializer` exposes `predecessor_count`, `is_blocked`, `linked_risks_count`, `linked_risks_max_severity` as read-only fields.
3. `RiskViewSet` adds `?task=<uuid>` filter (filter `tasks__id=task_id`).
4. `DependencyViewSet` adds `?task=<uuid>` filter (returns where `predecessor=task` OR `successor=task`).

### OSS or Enterprise
**OSS** — all features are single-project intelligence. Explicit Enterprise-only items:
- Cross-project risk rollups and portfolio risk aggregation (Enterprise — requires
  aggregating `Risk` rows across projects; violates the OSS single-project boundary)
- Portfolio overallocation heat maps (Enterprise — ADR-0030/ADR-0033)
- Risk-triggered approval workflows (Enterprise — no policy engine in OSS)
- Org-wide risk reporting / SOC 2 evidence export (Enterprise — cross-project aggregation)

The `risk_changed` signal from ADR-0010 is the OSS extension point; Enterprise attaches
receivers without modifying any OSS code.

### Durable Execution

1. **Broker-down behaviour**: N/A — feature is read-only on the API side
   (annotations only) and read-only on the frontend side (no new mutations).
   No async work introduced.
2. **Drain task**: N/A — no new async dispatch.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: N/A — annotations live directly in `TaskViewSet.get_queryset()`,
   which is the conventional location for read-only computed fields per ADR-0024
   and ADR-0025.
5. **API response on best-effort dispatch**: N/A — synchronous reads only.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: N/A — read-only.
8. **Dead-letter / failure handling**: N/A — annotation failures surface as 500
   responses; no async retry. If a Risk has both `probability` and `impact` null,
   `Max(...)` returns null which the serializer maps to `linked_risks_max_severity = 0`,
   which the frontend maps to "no severity color" (icon hidden). Defensive but
   acceptable.

## Out of Scope (deferred to b4+)
- **#185 SPI/CPI** — needs EVM data on Task (PV/EV/AC fields, baseline cost). **Frontend chip is complete** and no-ops gracefully when API fields are absent (`cpi`, `actual_cost`, `budget_at_completion` not in `TaskSerializer`). See `BoardCard.tsx::showSpiChip`/`showCpiChip` and `# TODO(#185)` comment in `serializers.py`.
- **#196 P80 distribution panel** — needs Monte Carlo result store (ADR-0012 added the endpoint, not the store)
- **#189 Cost burn on cards** — needs cost model (#73, #74)
- **#191 Saved views and quick filters** — needs view persistence layer
- **#170 Configurable columns editor** — `BoardColumnConfig` exists (ADR-0013); the editor UI is the remaining work
