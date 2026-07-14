# ADR-0420: Board matrix — opt-in, exception-aware per-cell card cap

## Status
Proposed

## Context

TruePPM's Kanban board is a phase(or assignee)×status **matrix** (ADR-0192). Each
cell (`BoardCellImpl`, `BoardView.tsx`) renders `tasks.map` into an unbounded vertical
`flex-col`. A busy cell (e.g. 25 cards in "In Progress") blows out the whole matrix
**row** height, so the phase×status grid stops being scannable at a glance and rows lose
alignment — the density discipline the Visiban board had ("a column is never one giant
stack") that TruePPM dropped.

**No existing mechanism bounds a single cell's height:**
- WIP breach chips (web-rules 159/176, ADR-0130) *warn* but don't bound.
- `ColumnStub` column collapse (web-rules 237/238, ADR-0192) collapses a whole **status
  column across all phases** — the wrong axis; it can't tidy one tall cell.
- Mobile reflow (`MobileBoard`, web-rule 193) is mobile-only.

**P3M layer:** Programs and Projects (single-project board execution surface) → **OSS**.
No cross-project aggregation, no OSS/Enterprise boundary concern.

**Prior review (already run):**
- `/voc` (uniform-cap version): avg ~5.5/10 with **one 🔴** (Alex/Scrum Master — a
  uniform cap hides the WIP-overload pile he scans for). Conditions: breached cells
  exempt; never collapse an exception card (blocked/at-risk/critical/**my-own**);
  priority-order the visible N; keep the overload signal loud; team-controllable,
  **default expanded**; My Work never gains a click. Net-new value judged "thin" → the
  design must be lightweight and not add a competing idiom.
- `/ux-review`: **decline** the uniform hard cap (fails Information Hierarchy) and the
  2-col-grid variant (doesn't solve the *vertical* problem). The only defensible shape
  is the conditional cap, reusing `ColumnStub`'s visual language and a rule-210-compliant
  disclosure. A new web rule is needed.

## Decision

Add an **opt-in, exception-aware per-cell card cap** to the desktop matrix. It is a
per-user client view-state preference (never server config), **off by default**, and it
never hides a signal:

1. **Off by default; team-controllable.** New additive field `cellCap: number | null` on
   `useBoardToolbarPrefs` (`trueppm.board.toolbarPrefs.v1`, the rule-199 client-view
   precedent, ADR-0192 client-localStorage split). `null` = off (today's unbounded
   behavior). The toolbar "Density"/overflow area gets an on/off control that sets a
   **fixed `DEFAULT_CELL_CAP = 6`** when enabled (a small menu Off/6/12 is a trivial
   later extension; ship the on/off first — VoC "keep it lightweight"). Additive-field
   coercion follows the `zoom`/`groupBy` precedent (missing key → default, no version
   bump; unknown value → `null`).

2. **Breached cells are never capped (the 🔴 fix).** If `wipState(tasks.length, wipLimit)`
   is `at`/`over`, the cell renders **every** card — the overload pile stays visible.
   Capping applies only to cells at/under WIP. This structurally satisfies "keep the
   overload signal loud": a *capped* cell is by definition under-WIP, so there is no
   breach signal to preserve on it.

3. **Exception cards are never collapsed.** A pure classifier keeps these above the fold:
   - **worst-offender signal** — `classifyCardSignal(...) !== null` (the existing
     `cardSignal.ts` tiers: blocked → stale/SLA → critical-path/negative-float → behind/EVM);
   - **my-own** — `task.assignees.some(a => a.resourceId === myResourceId)`.
   Because my-own cards are always exceptions, a capped cell **never hides one of the
   current user's cards** — so the rule-238 "N of your cards hidden" accent is moot on a
   capped cell (nothing of yours is ever hidden here). And because My Work is a separate
   surface, it is untouched.

4. **The visible remainder is priority-ordered.** After keeping all exceptions, fill the
   remaining slots up to `cap` with the top-K non-exception cards by `priorityRank`
   (lower = higher priority); the rest go to overflow. If exceptions alone already meet
   or exceed `cap`, show all exceptions and cap only the calm remainder to zero — the cap
   is a floor on *what's shown*, never a ceiling that hides an exception.

5. **"+N more" is a rule-210 disclosure that reuses `ColumnStub`'s language.** A real
   `<button aria-expanded aria-controls>` whose expanded state comes from an explicit
   per-cell toggle (never `group-hover`/`focus-within`). Its badge borrows `ColumnStub`'s
   `badgeClass` tone + `tppm-mono tabular-nums` count; accessible name carries the hidden
   count (`"Show 6 more cards"`). Expanding reveals the overflow in place
   (`motion-safe:` height reflow); collapsing returns focus to the toggle. Per-cell
   expanded state is ephemeral React state (not persisted) — resets on reload, like a
   transient disclosure.

6. **Keyboard stays whole (rule 105).** The board's only keyboard status-change path is
   the card `···` "Move to…" menu, which lives on a rendered card. `moveFocusInColumn`
   (J/K) iterates the full cell list, so it can target a capped-out card with no DOM node.
   Fix: **when keyboard focus enters a would-be-hidden card, auto-expand that cell** (set
   its expanded state) so the card renders and its `···` menu is reachable. This mirrors
   how `moveFocusInPhase` already skips collapsed columns — keyboard nav never strands a
   card.

7. **Drag-drop is unaffected; a drop into a capped cell auto-expands it.** The drop target
   is the whole cell (`useDroppable`, `${phaseId}:${status}`), independent of the cap. A
   card dragged into a capped cell re-derives the slice and may sort into overflow; to
   keep the user oriented, **a drop into a capped cell auto-expands it** (same auto-expand
   as keyboard), so the just-moved card is visible where it landed.

8. **Desktop matrix only.** `MobileBoard` (rule 193) is a flattened full-width
   single-status list where vertical scroll is native and expected; the matrix
   row-height problem doesn't exist there. The cap does not apply on mobile (scope guard,
   like every other matrix-only affordance).

9. **New web rule 259** codifies the invariants (exemption + signal-preservation +
   disclosure discipline + keyboard auto-expand); see Implementation Notes.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Conditional cap (chosen)** | Solves row-height, keeps every signal, opt-in, reuses existing chrome | More logic than a naive cap; a new classifier + disclosure to maintain |
| Uniform hard cap (original ask) | Trivial (`tasks.slice(0,N)` + "+N more") | 🔴 hides the WIP-overload pile (Alex); flattens overloaded vs calm cells; fights rule-176 |
| Compact 2-col grid in busy cells | Denser | Doesn't solve the **vertical** problem (25 cards ÷ 2 ≈ 13 rows tall); cramped; fights mobile reflow |
| Per-cell `max-height` + internal scroll | No cards hidden | Nested scroll-in-grid is a known anti-pattern; breaks drag ergonomics; scrollbar noise |
| Server-side cap on `BoardColumnConfig` | Shared across team | View-state belongs client-side (ADR-0192); a shared cap is a mandate (fails Morgan autonomy) |

## Consequences

- **Easier:** a busy board stays a scannable, row-aligned matrix without losing any
  actionable card; the density story is complete (WIP warn + column collapse + cell cap +
  mobile reflow).
- **Harder:** the board grows a second "there's more hidden here" affordance; mitigated by
  reusing `ColumnStub`'s exact visual language so they read as one family, and by scoping
  the cap to non-breached cells so the two never fire on the same overloaded cell.
- **Risks:** (a) keyboard focus into the hidden tail — mitigated by auto-expand;
  (b) memoization regression if the slice isn't reference-stable — mitigated by computing
  it in a `useMemo` keyed on the already-stable `tasks`/pref/`myResourceId`;
  (c) the classifier depends on fields that can be absent for low-privileged viewers
  (`blockedReason`, EVM `spiBand`/`cpi`) — treat absent as "not an exception" (fail-open
  to *showing*, never hiding).

## Implementation Notes

- **P3M layer:** Programs and Projects (single-project board). **OSS.**
- **Affected packages:** web only.
- **Migration required:** no.
- **API changes:** no. Pure client view-state (localStorage) + render logic.
- **OSS or Enterprise:** OSS (`trueppm-suite`).
- **New files:** `features/board/cellCap.ts` (pure `selectVisibleCards(tasks, {cap, myResourceId})`
  → `{ visible: Task[], overflow: Task[] }`, unit-tested in `cellCap.test.ts`).
- **Touched:** `useBoardToolbarPrefs.ts` (+`cellCap` field, setter, coercion),
  `BoardView.tsx` (`BoardCellImpl` slice + "+N more" disclosure + per-cell expand state +
  keyboard/drop auto-expand; toolbar on/off control), tests
  (`BoardView.test.tsx`, `useBoardToolbarPrefs.test.ts`, new `cellCap.test.ts`,
  `board-viewability.spec.ts` e2e).
- **New web rule 259** (add to `packages/web/CLAUDE.md`): "A board per-cell card cap is
  opt-in (client pref, default off), never caps a WIP-breached cell, never collapses an
  exception card (`classifyCardSignal(...) !== null` ∪ my-own), priority-orders the
  visible remainder, exposes overflow via a rule-210 `aria-expanded` disclosure reusing
  `ColumnStub` chrome, and auto-expands the cell when keyboard focus or a drop enters the
  hidden tail so rule-105 keyboard reach is never lost. Desktop matrix only; `MobileBoard`
  unchanged (rule 193)."

### Durable Execution
Pure client-side UI feature — no async work, no server writes, no Celery, no broker.
1. Broker-down behaviour: **N/A** — no async side effects (localStorage + render only).
2. Drain task: **N/A** — no task dispatched.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — no server call; no CPM recalc.
5. API response on best-effort dispatch: **N/A** — no API call.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — no mutation; pref writes are last-write-wins localStorage, and
   the cross-tab `storage` listener already reconciles.
8. Dead-letter / failure handling: **N/A** — no failable operation; a corrupt/unknown
   `cellCap` value coerces to `null` (off) in `read()`, the existing safe fallback.
