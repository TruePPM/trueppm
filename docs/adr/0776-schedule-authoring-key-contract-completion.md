# ADR-0776: Completing the Schedule outline's authoring key contract and treegrid semantics

## Status
Accepted

## Context

Issue #2727 (epic #2739, "Project Designer — the authoring spine") asks for the rest of
the Schedule build-mode keyboard contract plus real treegrid/list accessibility semantics.
The issue's provenance is a design handoff (Claude Design, `design_handoff_trueppm_v4/`)
plus a code-verification pass — "the panel is not user research and is not evidence."
Six points in the target spec are underspecified or in direct tension with existing,
already-shipped decisions elsewhere in the codebase, and need resolving before
implementation:

1. **Multi-select** (Shift+↑/↓ extends selection, ⌘A selects siblings then the whole
   tree) does not exist at all. `useScheduleFocus.ts`'s `ScheduleFocusState` is
   single-row (`rowId: string | null`), and ADR-0054 flagged "multi-row select" as
   anticipated-but-undesigned future work (line 134: *"Future build-mode features
   (paste from Excel, multi-row select, fill-down) compose against the focus state
   machine, not against ad-hoc keyboard handlers."*). No prior ADR extends it.
2. **⌘D duplicate** today clones a single row only; `useTaskMutations.ts`'s
   `useDuplicateTask` has a comment citing "ADR-0066 Q1: dependencies are never
   cloned." Reading ADR-0066 itself, that line is a *scope* decision (which endpoint
   to use), not an argued semantic rule — there is no sentence anywhere in ADR-0066
   explaining why dependency-cloning would be undesirable. The new spec asks for
   "Duplicate row **+ subtree**," which this ADR needs to reconcile against the
   existing single-row contract.
3. **F8 / Shift+F8** ("jump to next/previous unresolved row") — "unresolved" is
   undefined in the issue text.
4. **Esc discarding an empty just-created row** directly contradicts a currently
   passing e2e test (`schedule-build-mode.spec.ts`, "Escape in the new row Name cell
   reverts to the row without deleting it," asserting `deleteCount === 0`).
5. **Alt+A Author/Read toggle, "persists per project"** — no prior art for a
   per-project view-mode concept in this codebase.
6. **Tab/Shift+Tab for indent/outdent** is already live in Schedule (pre-dates
   #2727) and the issue's key table asks to keep it. But `packages/web/src/features/
   grid/OutlineMode.tsx` already hit and fixed the *identical* pattern as a WCAG
   2.1.2 keyboard trap (#2192, a11y audit 2026-07-18): binding Tab to indent means
   every Tab keydown is `preventDefault()`'d, so a keyboard user can never Tab out
   of the grid, and every escape attempt fires a mutation. That fix moved
   `OutlineMode` to Alt+→/Alt+←, with a regression test (`OutlineMode.test.tsx:174-
   195`) asserting Tab is *not* prevented and fires no mutation. Schedule's
   `handleBuildModeKeyDown` (`TaskListRow.tsx`) has the same shape today and no such
   test. #2727 carries the `accessibility` label and mandates real `aria-level`/
   `aria-expanded`/`aria-selected` treegrid semantics — shipping that while keeping
   a known, previously-fixed WCAG failure would be self-contradictory.
7. **"Enter … works on the Timeline too"** collides with two already-shipped, tested
   bindings on the canvas Timeline's `ScheduleAriaOverlay.tsx`: `Enter` already opens
   the task detail drawer (#2205, a WCAG 2.1.1 consistency fix — Enter on a focused
   bar mirrors the task-list row and canvas double-click), and `Shift+Enter` already
   starts a keyboard reschedule (`ScheduleAriaOverlay.keyboard.test.tsx` covers the
   interplay between the two). The issue's literal ask — Enter creates a sibling row
   inline on the Timeline too — would require relocating both existing bindings
   somewhere else on an already-tested surface, which is real rework with real
   regression risk, not an additive change.

## Decision

### 1. Multi-select — a selection layer on top of the existing focus machine

Extend `ScheduleFocusState`/`useScheduleFocus` with a `selectedIds: Set<string> | null`
alongside the existing single `rowId` (which remains the *anchor* — the last row
explicitly moved to or clicked). `Shift+↑/↓` extends a contiguous range from the anchor
through the current flattened-visible row order (`flattenVisible`, already in
`buildWbsTree.ts`). `⌘A`: first press selects every sibling of the focused row (same
parent); a second press while that exact "all siblings" set is already selected expands
to the whole visible tree, matching the issue's literal "again selects the whole tree."

Structural keys act on the **whole selection** when one is active, not just the anchor:
`Alt+→/←` (indent/outdent — see point 6), `Backspace`/`Delete`, and `⌘D` (duplicate) all
apply per-selected-row. `Alt+↑/↓` (move) is scoped to a **contiguous, same-parent**
selection — reordering a scattered, cross-level selection has no well-defined single
target position, so the key is a no-op outside that case rather than guessing.

### 2. ⌘D duplicates the row and its subtree; dependency-cloning stays "never," extended uniformly

Amends **ADR-0066 §Q1**: duplication now walks the source row's full subtree
(`buildWbsTree` + a new subtree-collector, since no such utility exists yet — the
codebase's existing subtree tools either count descendants or expand-all, never collect
the actual node objects) and creates it top-down, remapping each child's `parent_id` to
its newly-created parent's id as it goes. The **"dependencies are never cloned" rule
is extended uniformly to every duplicated node**, including edges *internal* to the
duplicated subtree (if child A depends on child B in the source, the clone A′ does not
depend on B′). This is a clarification of ADR-0066's scope, not a reversal: Q1 chose the
existing-endpoint, no-new-machinery path specifically to avoid the added complexity a
dependency-remapping pass would require (Q1B's rejected alternative), and that reasoning
applies exactly as much to subtree-internal edges as to the single-row case it was
written for. A future issue can revisit this if a real user report asks for it — no such
report exists today.

When multiple subtrees are duplicated at once (multi-select), only **top-level selected
nodes** are duplicated as subtree roots — a selected node whose ancestor is also
selected is skipped as an explicit root (it is already covered by its ancestor's
subtree walk), so nothing is duplicated twice.

### 3. F8 "unresolved" = an unresolved `@owner` token

The only concept the codebase itself calls "unresolved" inside the Schedule surface is
`UnresolvedOwnerName.tsx` — an `@owner` token that matched no roster member (ADR-0774
§6). `isBlocked`/`blockedReason` (ADR-0124) and `dor`/`dor_blockers` (ADR-0105) are real
"problem" states, but they are Board- and Backlog-scoped respectively and have never
been plumbed into the Schedule task list or its serializer response — adopting either as
part of F8's predicate would be a cross-surface feature import, not a rename. F8/Shift+F8
therefore jump between rows whose current name contains an unresolved owner token, v1
scope. Extending the predicate to OR against `isBlocked`/`dor_blockers` once (if) those
land in Schedule's own row data is a natural, additive follow-up, not a redesign — noted
here so it isn't rediscovered as a fresh question later.

### 4. Esc discards a still-pristine row; reuses #2682's pristine-tracking, not a new mechanism

#2682 (this epic's immediately-preceding issue) already had to solve an adjacent
problem: `insertBelow`'s created row needs a non-blank server-side name (the API rejects
blank), but the Name cell must still *look and behave* blank until the user types —
covered by `BuildModeApi.isPristineNewRow`/`clearPristineNewRow`. Esc's new "discard an
empty row" behavior is the same predicate: if the row being escaped-out-of is still
pristine (never committed a real value), Esc calls `buildMode.deleteTask` and clears
focus instead of rolling back to `RowFocused`. A row that has ever been committed,
rolled back once, or had a real value typed is no longer pristine and gets the existing
rollback-to-last-committed-value behavior. This flips
`schedule-build-mode.spec.ts`'s "Escape in the new row Name cell reverts to the row
without deleting it" test — deliberately; the new behavior is what #2727 asks for, and
the old test encoded the *previous* deliberate choice, not an unrelated invariant.

Popover-closes-first ordering (`OwnerAutocomplete`/`NameAutocomplete`/
`MilestoneDatePopover`) is unaffected — each already owns its local Escape→close handler
and stops there; this ADR's Esc change is scoped to the row/cell layer underneath, which
those popovers already sit in front of.

### 5. Alt+A — a per-user-per-project localStorage preference, not a permission change

Follows the exact convention already established by `useMyTasksFilter.ts` (the closest
per-project, per-user browser preference in the codebase): key
`trueppm.schedule.authorMode.<userId>.<projectId>`, hydrated once user+project resolve,
persisted on toggle. This is **not** a role or permission change — the server's RBAC is
untouched. "Read" mode is a client-side override that forces the Schedule view's
existing `readOnly` computation to `true` regardless of role, a personal "look, don't
touch" mode for reviewing a plan without risking an accidental edit. It needs a visible
toolbar affordance (mirroring `BuildModePill`) so the mode is never silently active —
an invisible mode flip is worse than the discoverability gap #2682 already had to fix
for the properties button.

### 6. Tab/Shift+Tab is rebound to Alt+→/Alt+← for indent/outdent, matching `OutlineMode`

Deviates from the issue's literal key table. Schedule's existing Tab-as-indent binding
reproduces the exact WCAG 2.1.2 shape already found and fixed once in this codebase
(#2192): every Tab keydown intercepted, no way to leave the grid via keyboard, every
escape attempt firing a mutation. `OutlineMode.tsx`'s fix — Alt+→/Alt+← for indent/
outdent, plain Tab left untouched — is adopted verbatim for consistency (the two
surfaces should not teach the user two different structural-editing key models). A
regression test mirroring `OutlineMode.test.tsx:174-195` (Tab keydown is not
`preventDefault()`'d, fires no indent/outdent mutation) is added for Schedule.

### 7. Enter-to-create is scoped to the task list (Grid); Timeline parity is deferred

The three Enter variants (plain, Shift, ⌘/Ctrl) are implemented for the Grid task list
only. The Timeline's existing `Enter` (open drawer, #2205) and `Shift+Enter` (start
keyboard reschedule) bindings are left exactly as shipped — relocating two tested,
already-shipped bindings to make room, on the same branch that is also reworking the
Grid's key contract, is more risk than this issue's actual ask requires. Timeline
parity for Enter-creates-a-row is folded into the same follow-up issue as the deferred
⌘Z/⌘⇧K work (§ Consequences), since it is a genuinely separate design question (where
do "open drawer" and "reschedule" go on the Timeline once Enter is reassigned?) that
deserves its own resolution rather than an ADR-in-passing.

### 8. Timeline ARIA: `role="listbox"`/`option`, not the issue's literal `role="list"`/`listitem`

The issue's accessibility section asks for `role="list"` with one `listitem` per bar. That
was implemented first and reverted after two independent, automated checks rejected it:
axe-core's `aria-allowed-attr` rule (critical severity) — `aria-selected` is not a
permitted attribute on `listitem` — and eslint-plugin-jsx-a11y's
`no-noninteractive-tabindex` / `no-noninteractive-element-interactions` — `listitem` is a
non-interactive role, and every bar needs `tabIndex`, `onFocus`, and `onKeyDown` for the
roving-tabindex keyboard contract (`ArrowUp/Down`, `Home`/`End`, `Enter`, `Shift+Enter`,
`r`, `Space`) that already ships and is under test
(`ScheduleAriaOverlay.keyboard.test.tsx`). `list`/`listitem` is defined for static content
grouping, not a keyboard-navigable, selectable widget — it was never going to pass either
check regardless of implementation care.

`role="listbox"` / `role="option"` is ARIA's actual pairing for "a keyboard-navigable,
selectable set of items" — the same "one interactive target per row, not a 2D grid" shape
the issue was asking for (every row already has exactly one interactive cell; there is no
horizontal cell-to-cell navigation, so `grid`'s 2D contract never fit either), with
first-class, spec-legal support for `aria-selected` and roving tabindex. `aria-rowcount` /
`aria-rowindex` (grid-only properties) are replaced with `aria-setsize` / `aria-posinset`,
the listbox/option equivalents for describing a virtualized item's position without every
sibling present in the DOM.

### 9. Delivery-mode visual encoding: gutter + texture + chip, via a dedicated `ux-design` pass

The issue names the requirement ("delivery mode never color alone") but not the pixel-
level design — no gutter width/position, texture pattern, or chip placement was specified,
and delivery mode was not rendered on the Gantt bars *at all* before this issue (this is
net-new rendering work, not a fix to an existing color-only encoding). Per this project's
own gate table, new visual language on an existing surface goes through `ux-design` before
implementation; that pass (grounded in a full read of `GanttRenderer.ts`'s existing bar
draw order, z-order, and dimming/selection/critical-path visual language) produced the
concrete spec that shipped: a 3px left-edge gutter (always visible even on a 2px-clamped
bar), a low-alpha texture across the bar body (diagonal stripes for Scrum, a dot grid for
Kanban, cross-hatch for the rare `'milestone'` delivery-mode value landing on an actual
bar rather than a diamond), and a mode-letter prefix folded into the existing progress
chip rather than a second chip competing for the same left-anchored space. Waterfall (the
default/baseline mode) and external-redacted bars draw none of it — omission is the
"nothing special" signal, consistent with how the existing chip already treats a fresh
`NOT_STARTED` task. Full spec reasoning lives in the implementing MR's description.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Multi-select as a Set on `ScheduleFocusState`** (chosen) | Single source of truth; every existing `rowId`-keyed check (`isRowFocused`, etc.) extends naturally to "is this row in the selection" | Slightly larger reducer surface |
| Multi-select as a fully separate hook/context | Cleaner separation | Two sources of truth for "what's selected" — every consumer would need to reconcile focus vs. selection independently |
| **⌘D subtree, deps never cloned uniformly** (chosen) | Consistent with existing ADR-0066 rule; no new endpoint or remapping-of-remapping complexity | A subtree with rich internal dependencies loses them on duplicate — acceptable today, revisit if reported |
| ⌘D subtree, clone internal deps only | More "faithful" duplicate | Requires an old-id→new-id edge-remapping pass with its own failure modes (partial subtree selection, cross-boundary edges) for a case nobody has asked for yet |
| **F8 = unresolved owner token only** (chosen) | Zero new plumbing; matches the word "unresolved" as the codebase itself already uses it | Doesn't cover `isBlocked`/DoR rows in Schedule (they aren't there to cover yet) |
| F8 = OR across owner-token + isBlocked + dor_blockers | More complete "problem row" concept | Requires importing two Board/Backlog-only fields into Schedule's task list/serializer response — a separate feature, not this issue's scope |
| **Esc discards pristine rows via #2682's tracking** (chosen) | Reuses existing, tested infra; zero new state | Flips one existing e2e test (intentional, matches the new spec) |
| **Alt+A as client-only localStorage toggle** (chosen) | No RBAC risk; matches existing per-project pref convention exactly | Not a real permission — a determined user can flip it back; acceptable, it was never meant to be enforcement |
| Alt+A as a server-persisted setting | Survives across browsers | Massive overkill for a "don't fat-finger an edit while I'm reading" convenience toggle; no other Schedule preference is server-persisted either |
| **Alt+→/← for indent/outdent** (chosen) | Closes a real, previously-documented WCAG 2.1.2 failure; matches `OutlineMode`'s already-shipped, already-tested fix | Deviates from the issue's literal key table; existing Tab-indent users (opt-in beta cohort) get a rebind |
| Keep Tab/Shift+Tab as specced | Matches the design handoff literally | Ships a known keyboard-trap class into a second surface under an issue that carries the `accessibility` label |
| **Enter-to-create scoped to Grid, Timeline deferred** (chosen) | Zero regression risk to #2205's tested drawer-open/reschedule bindings | Timeline doesn't get Enter-to-create in this branch, despite the issue asking for it |
| Relocate Timeline's Enter/Shift+Enter to make room | Matches the issue literally | Reworks a tested, shipped surface's keyboard contract as a side effect of an unrelated issue — real regression risk for no user-requested benefit today |
| **Timeline `role="listbox"`/`option`** (chosen) | Passes axe-core `aria-allowed-attr` and eslint-plugin-jsx-a11y's non-interactive-role rules; spec-legal `aria-selected` + roving tabindex | Deviates from the issue's literal `role="list"`/`listitem` |
| Timeline `role="list"`/`listitem` as specced | Matches the issue literally | Fails a critical-severity axe-core rule (`aria-selected` not allowed on `listitem`) and two eslint-plugin-jsx-a11y rules (non-interactive role with keyboard handlers) — not shippable as specified |
| **Delivery-mode gutter+texture+chip via `ux-design`** (chosen) | Concrete spec grounded in the renderer's actual z-order/dimming/selection language, so it composes instead of conflicting | One more design-then-implement round trip before code |
| Guess a reasonable encoding without a design pass | Faster | No existing rendering to anchor against (delivery mode wasn't drawn at all before); real risk of colliding with the existing chip's left-anchor or the critical-path frame's outer-edge claim |

## Consequences

- Multi-select, subtree-duplicate, and the Alt+A toggle are new client-only surface —
  no migration, no API change.
- The Tab→Alt+Arrow rebind is a breaking change for the small existing build-mode-beta
  cohort's muscle memory; the cheatsheet, docs, and toolbar hint strip all need the
  updated binding, in the same commit as the code change.
- Esc's flipped behavior is scoped precisely to *never-committed* rows — an edited-then-
  reverted row is unaffected, so this does not become "Esc sometimes deletes your work"
  in the general case.
- F8's v1 scope (owner-token-only) is honestly narrower than "unresolved" might suggest;
  documented here so the gap is a known, findable decision rather than a silent omission
  the next reader has to re-derive.
- "Inherits parent, calendar and delivery mode" (the Enter/Shift+Enter/⌘+Enter row):
  `Task` has no client-settable calendar field at all today (grepped the model and
  `TaskSerializer` — none exists; calendar resolution is derived server-side from the
  project/resource graph, not a per-task override a client can copy). So "inherits
  calendar" needs no code — a new sibling already gets the same derived calendar as
  its neighbors, there is nothing to lose. "Inherits delivery mode" is real and was a
  genuine gap: `insertBelow` never sent `delivery_mode`, so a new row silently
  defaulted server-side (`waterfall`) instead of matching its sibling. Fixed as part
  of this ADR's Enter-variant work, not scoped out.
- The Timeline's `role="listbox"`/`option` rename is a locator-breaking change for
  every test (vitest and Playwright) that targets the overlay by role — every
  affected spec was updated in the same commit and re-run against the real build,
  same discipline as the Tab→Alt+Arrow rebind above.
- Delivery-mode gutter/texture/chip is the first Gantt-bar rendering that reads
  `task.deliveryMode` at all — a future methodology value beyond `waterfall` /
  `scrum` / `kanban` / `milestone` needs its own texture pattern and palette
  entries in `GanttRenderer.ts` (`COLOR`/`COLOR_DARK`/`COLOR_FORCED` all three,
  enforced by the `ColorPalette` type), not just a `DeliveryMode` union update.

## Implementation Notes
- P3M layer: Programs and Projects (single-project task authoring)
- Affected packages: web only
- Migration required: no
- API changes: no — all nine points are client-side; ⌘D's subtree duplicate composes
  the existing `POST /tasks/` endpoint multiple times (already how single-row duplicate
  and `insertBelow` work), no new server surface
- OSS or Enterprise: OSS (single-project authoring, no cross-program surface)

### Durable Execution
1. Broker-down behaviour: N/A — no async dispatch, this is synchronous client-driven
   REST calls against an already-existing endpoint (`POST /tasks/`), same durability
   posture as every other build-mode mutation today.
2. Drain task: N/A — no new async work category.
3. Orphan window: N/A.
4. Service layer: N/A — no new server code path; reuses `TaskViewSet.perform_create`
   exactly as `useDuplicateTask` and `insertBelow` already do.
5. API response on best-effort dispatch: N/A — every call in this ADR is a normal
   synchronous `20x`/`4xx` REST response, not a queued/best-effort dispatch.
6. Outbox cleanup: N/A.
7. Idempotency: N/A at the mutation layer — each subtree-duplicate POST is a distinct,
   idempotency-key-free create, matching every other task-create call in the app; a
   double-fire (e.g. a flaky double-click) creates two rows, the same pre-existing
   behavior as today's single-row duplicate and Enter-insert.
8. Dead-letter / failure handling: N/A — synchronous REST; a failed POST mid-subtree-
   walk surfaces via the existing toast-on-error pattern and leaves whatever prefix of
   the subtree already succeeded in place (no rollback of partial creates), same
   trade-off single-row create already accepts.
