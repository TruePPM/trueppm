# ADR-0056: Schedule Render Parity (#248) + Milestone Toolbar (#340)

## Status
Accepted

## Context

Two coordinated passes on the Schedule view that close gaps between the current implementation and the target design, executed as bundle A2 after ADR-0054 (Schedule build mode v1):

| Source | Gap |
|---|---|
| #248 (1) | Visible WBS number column — currently only conveyed via Task-name indent depth; users cannot scan-read paths like "1.2.3" without inferring depth |
| #248 (2) | Owner avatar column — assignees are currently inline next to the task name (only when no dep chips), so a glance "who's on this row" requires opening the task drawer |
| #248 (3) | "CP only" / "Focus chain" filters render as plain `<input type="checkbox">` instead of styled toggle buttons; missing "Critical path" / "Milestones" toggles |
| #248 (4) | No summary stat chip in toolbar (`{N} tasks · {critical} critical · CPM ✓`) |
| #340 | No first-class CRUD path for milestones — currently requires opening the Add Task modal, scrolling, toggling Is Milestone. Sarah creates 8–15 milestones per project; the modal trip is the bottleneck |

**P3M layer**: Programs and Projects (single-project execution surface). **OSS.**

**VoC summary** (run before architect):
- Average 5.83/10; Sarah primary at 8/10 — the highest score we've seen on a Schedule pass
- David second at 7/10 — Owner avatar column is the first time the Schedule itself answers "who's busy"
- 🟡 Mobile gap continues from A1 (desktop only, documented)
- 🟡 Summary chip needs loading skeleton (Marcus → CEO meeting reliability)
- 🟡 Owner avatar column stack must be readable on eye-scan (vertical alignment + room for a future "highlight rows for one assignee" filter)
- 🟡 Verify milestone insert does NOT trigger personal notifications (Priya's no-spam concern) — research confirmed: **no personal-notification fanout exists in the codebase**, only project-channel broadcast. Concern resolved without code change.
- No 🔴 blockers.

## Decision

Five focused changes, each grounded in an existing primitive — zero new patterns introduced.

### 1. Filter chain extension, not renderer changes (#248 toggles)

The `GanttRenderer` is stateless (`GanttRenderer.ts:1-15`) — it draws whatever `tasks` array it's given. The "Critical path" and "Milestones" toggles add to the `visibleTasks` `useMemo` at `ScheduleView.tsx:180-203`:

```ts
const visibleTasks = useMemo(() => {
  let result = flattenVisible(buildWbsTree(allTasks), expandedIds);
  if (showCriticalOnly) result = result.filter((t) => t.isCritical || t.isSummary);
  if (showMilestonesOnly) result = result.filter((t) => t.isMilestone || t.isSummary);
  // …existing filters (cpOnly etc.)
  return result;
}, [allTasks, expandedIds, showCriticalOnly, showMilestonesOnly /*…*/]);
```

Summary tasks stay visible in both filtered modes so the WBS hierarchy doesn't collapse to flat. **No renderer changes**. Toggle state is local view-state in `useScheduleStore` (matches `selectedTaskId`/`expandedIds` precedent).

### 2. Toggle button primitive — copy `ZoomControl` exactly (#248 styling)

`ZoomControl.tsx:11-40` is the canonical `aria-pressed` toggle pattern. Replace the four plain checkboxes (CP only, Focus chain) and add (Critical path, Milestones) with the same shape:

```tsx
<button
  type="button"
  aria-pressed={selected}
  onClick={() => set(!selected)}
  className={selected ? ACTIVE_CLASSES : INACTIVE_CLASSES}
>
  {label}
</button>
```

All four sit in a `role="group" aria-label="Schedule filters"` cluster in the existing toolbar. No new component file — buttons inline in `ScheduleView.tsx` (or a small `ScheduleToolbarFilters.tsx` helper if the JSX gets noisy).

### 3. Summary stat chip — read existing `useSchedulerStore` (#248 chip)

CPM error/cycle status already exists at `useSchedulerStore` (`schedulerStore.ts:1-30`):

```ts
const { isRecalculating, cpmError } = useSchedulerStore();
const taskCount = visibleTasks.length;
const criticalCount = visibleTasks.filter((t) => t.isCritical).length;
const cpmIcon = isRecalculating ? null
  : cpmError ? '⚠'
  : '✓';
```

Loading state (Marcus's 🟡): when `isRecalculating === true`, render the chip with a `<span className="animate-pulse opacity-50">…</span>` skeleton on the count area, hold the icon slot empty. No flicker between data states.

### 4. New columns: WBS + Owner (#248 columns)

Both extend `useColumnWidths`:

| Column | Default width | Min | Render |
|---|---|---|---|
| `wbs` | 56 | 40 | Right-aligned, `tppm-mono`, `text-neutral-text-secondary`, displays `task.wbs` (e.g. "1.2.3"). Hidden by default for non-Sarah personas? **No — visible by default**; users can hide via the existing Columns popover. |
| `owner` | 72 | 56 | Existing `<AssigneeChips>` extended with a `size="sm"` prop (24 px circles, was hardcoded 16 px) and a `max` prop (default 3, was hardcoded 2). Centered horizontally; row-height stays at 28 px. |

`AssigneeChips` extension is **additive** — the existing call sites pass no new props, so existing rendering is unchanged.

**`useColumnWidths` localStorage version bump**: `WIDTHS_KEY` goes from `v4` → `v5` (`useColumnWidths.ts:4`). Adding new keys to `DEFAULTS`/`MIN_COL_WIDTHS`/`DEFAULT_VISIBILITY` makes prior persisted widths still usable (the merge falls back to defaults), but bumping is the cleaner pattern and matches every prior column-set evolution.

**Avatar stack readability** (David's 🟡): each row's avatar group is left-aligned within the column with a fixed-pixel gap so rows align vertically. When a future "filter to one assignee" feature lands, those aligned avatars become a visual signal — designed-for now to avoid a re-architecture later.

### 5. `+ New milestone` button + ⌘M (#340)

Outlined-ghost button (rule §39), gold `border-brand-accent/40 bg-transparent text-brand-accent`, peer to `+ Task` in the toolbar. Click handler and ⌘M handler share `handleAddMilestone`:

```ts
const handleAddMilestone = useCallback(() => {
  if (!projectId || !canEdit) return;
  const today = new Date().toISOString().slice(0, 10);
  const parentId = inferNearestSummaryParent(focusRowId, visibleTasks); // null for root
  createTaskMut.mutate(
    { name: '', duration: 0, planned_start: today, parent_id: parentId, status: 'NOT_STARTED' },
    {
      onSuccess: (data) => {
        announceToLive(`Milestone ${data.name || 'untitled'} inserted at ${today}`);
        triggerDiamondPulse(data.id);
        if (buildModeActive) {
          focus.focusRow(data.id);
          focus.enterCellEdit(data.id, 'name');
        }
      },
    },
  );
}, [projectId, canEdit, focusRowId, visibleTasks, createTaskMut, /*…*/]);
```

`createTaskMut` is the **existing** `useCreateTask` hook — no signature change. The server already validates `is_milestone=true` requires `duration=0`. **Note**: the API contract is `is_milestone=true` not present on `useCreateTask.CreateTaskPayload` today (verified — only `name`, `duration`, `parent_id`, `status`, `planned_start`, `notes`, `sprint`). Adding `is_milestone?: boolean` to the payload and forwarding it is the only API-client change.

**`parent_id` inference rule**: walk back through `visibleTasks` from the currently-focused row's index; the first row with `is_summary === true` is the parent. If no row is focused or no summary above, `parent_id = null` (root level — milestones often live at root anyway). This matches what a user expects when they say "insert here under this phase."

### 6. ⌘M / Ctrl+M shortcut → extract `useScheduleKeyboard` hook

A1 left the `?` cheatsheet handler inline in a `useEffect` inside `ScheduleView.tsx`. Adding ⌘M without extraction means a second copy-pasted "is target editable?" guard — duplication grows fast. Extract a single hook now:

```ts
// packages/web/src/features/schedule/useScheduleKeyboard.ts
export function useScheduleKeyboard(
  bindings: Record<string, (e: KeyboardEvent) => void>,
): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = formatKey(e); // e.g. 'mod+m', '?', 'shift+?'
      bindings[key]?.(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bindings]);
}
```

Migrate the A1 `?` handler into this hook in the same MR. Single source of truth for "is the user typing in a field" gating across all view-scoped shortcuts.

### 7. Diamond pulse — SVG overlay sibling, NOT canvas

The canvas dirty-rect rules (rule §60) make a fading animation expensive — every frame would invalidate the entire bar row for 1.5 s. Instead: a new `MilestonePulseOverlay.tsx` mounted as a sibling to the canvas, positioned `absolute` over the timeline scroll container.

- Computes the diamond's x coordinate via `dateToLeft(today, scaleData)` (rule §56)
- Two `<circle>` SVG elements with CSS animation: `0% → opacity 0.6, r 8` → `100% → opacity 0, r 24`
- Self-removes after 1500 ms via `setTimeout`
- Honors `prefers-reduced-motion`: when `matchMedia('(prefers-reduced-motion: reduce)').matches`, the overlay does not mount at all (no need for a `motion-safe:` Tailwind utility — the component just early-returns). Matches the pattern at `ScheduleView.tsx:514` and `GanttEngineImpl.ts:166-168`.

The pulse is triggered by `triggerDiamondPulse(taskId)` from the milestone insert handler — sets a state `pulsingMilestoneId` that the overlay reads and clears after timeout.

**No `useReducedMotion` hook exists in the codebase** (research confirmed) — using `matchMedia` directly matches existing precedent. We could extract one in this MR, but the existing precedent is two callsites, and YAGNI applies.

### 8. Live region announcement — `ariaLiveRef` (polite)

Use the existing `ariaLiveRef` at `ScheduleView.tsx:175` (`aria-live="polite"`). Write via `ref.current.textContent = ...` (rule §30 — DOM, not React state, avoids re-render storms). The assertive region (rule §53) is reserved for keyboard-nudge feedback where the polite queue's latency would garble the message — milestone insert is an informational status, polite is correct.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Five focused changes (chosen)** | Each grounded in an existing primitive; zero new patterns; small surface area; reusable column extensions | Slightly more wiring than a single uber-component |
| B. Rewrite `TaskListPanel` with a column registry | Future column adds are one-line | YAGNI — we have 7 columns max for the foreseeable; registry overhead exceeds savings |
| C. Canvas-drawn pulse | Single rendering surface; consistent with bars | Fights dirty-rect invalidation (rule §60); fade animations on canvas are 30+ lines vs 8 lines of SVG |
| D. Defer toggles to ADR-0054 amendment | Saves an ADR | Different work pass; clearer to keep build-mode v1 atomic |
| E. New `ScheduleToolbar.tsx` component file | Cleaner separation | The toolbar JSX is already inline in `ScheduleView.tsx`; extraction is a refactor concern, not a feature concern; do separately if needed |

## Consequences

### Easier
- "Show me the critical path only" is a single click instead of an inferred read of red bars
- "Show me only milestones for the client meeting" is a single click instead of mental filtering
- Sarah's plan-laydown loop for milestones drops from "open modal → fill → save" to "⌘M → type → Enter"
- Marcus gets a 30-second project-health summary in the toolbar (Janet's tier)
- Future "filter to one assignee" / "highlight all rows for this person" features compose against the new Owner column — already designed for it
- `useScheduleKeyboard` becomes the single home for view-scoped shortcuts; A1's `?` and A2's ⌘M migrate together

### Harder
- Each new column adds visual density; the existing columns popover (`ScheduleView.tsx:618-645`) needs the two new entries so users can hide what they don't want
- `AssigneeChips` extension means existing call sites might benefit from the larger `size="sm"` variant — a future audit might consolidate
- The `MilestonePulseOverlay` is a new mount point that the engine doesn't manage — extra cleanup on unmount

### Risks
- **🟡 Owner avatar column display when no assignees** — render an empty space (not "—" placeholder) so unassigned tasks don't shout "needs assignee" via the column itself. The "Missing dates" warning chip pattern (`TaskListRow.tsx:88-93`) is the right precedent — show only when there's a problem, not always
- **🟡 Summary chip flicker on initial load** — the loading skeleton (above) addresses this; verify in the ux-review pass
- **🟡 ⌘M conflicts with browser bookmark-page on macOS Firefox** — Cmd+M minimizes the window in macOS, not bookmarks. Cmd+D bookmarks. Cmd+M is taken by the OS, but our handler runs before the OS in browser context. Verify in Playwright
- **No personal-notification fanout on milestone insert** — research confirmed the codebase has no personal-notification module (`apps/notifications/` does not exist). `broadcast_board_event` (`apps/sync/broadcast.py:22-54`) is project-channel only. Priya's no-spam concern resolved without code change. Documented here so we don't re-investigate later

## Implementation Notes

- **P3M layer**: Programs and Projects.
- **Affected packages**: `web` only.
- **Migration required**: no.
- **API changes**: minor — extend `useCreateTask.CreateTaskPayload` with `is_milestone?: boolean` and forward it to `POST /tasks/`. Server already accepts this field; the client just doesn't expose it today. **Not a contract change** — additive optional field.
- **OSS or Enterprise**: OSS.

### Durable Execution

1. **Broker-down behaviour**: N/A — milestone insert reuses `useCreateTask` → existing `POST /tasks/` view, which already follows the outbox pattern via `enqueue_recalculate(project_id)` for downstream CPM. No new dispatch path. All other A2 work is pure UI (toggles, columns, chip).
2. **Drain task**: N/A — no new async work introduced. CPM drain (`scheduling.tasks.recalculate_drain`) covers the post-insert recompute.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: N/A on the new code path. Reused `enqueue_recalculate(project_id)` is canonical.
5. **API response on best-effort dispatch**: N/A. `POST /tasks/` returns `201` with the created task synchronously, then triggers async CPM via the outbox — pre-existing behavior.
6. **Outbox cleanup**: N/A — existing outbox purge job covers any indirect rows generated by `enqueue_recalculate`.
7. **Idempotency**: Milestone insert is **not** idempotent — calling the handler twice creates two milestones. The frontend prevents double-fire by gating the ⌘M handler on `createTaskMut.isPending` (and similarly for the toolbar button via Tailwind `disabled:` + the same flag). For a server-side 5xx-with-actual-success retry, the worst case is one extra blank-name milestone — recoverable via Delete (in build mode) or via TaskFormModal. Acceptable for v1.
8. **Dead-letter / failure handling**: A failed insert surfaces as a toast with the server error. The optimistic UI does not advance (no row appears), so no rollback. CPM recompute failures use the existing `recalculate_drain` retry / DLQ behavior — out of scope.

### Test coverage strategy

- **vitest** on the new `useScheduleKeyboard` hook (Tab disambiguation isn't relevant here — just key-format parsing + editable-target gate)
- **vitest** on the column additions (TaskListHeader / TaskListRow render the new cells; visibility toggle works; AssigneeChips with `size="sm"` and `max=3` renders the right number of avatars + overflow chip)
- **vitest** on the toggle buttons (4 buttons, each with `aria-pressed` + click toggling, group landmark)
- **vitest** on the summary chip (loading state, ✓/⚠/computing rendering, count derivation from visibleTasks)
- **vitest** on `inferNearestSummaryParent` (focused row in middle of list / at top / at bottom / no focus → null)
- **vitest** on `MilestonePulseOverlay` (mount → unmount after 1500 ms; no mount under reduced motion)
- **Playwright** (using #348 shared API-mock fixture):
  - Click `+ New milestone` → diamond appears at today on the timeline → row appears in the list with empty name field focused
  - Press ⌘M → same flow
  - Press ⌘M while typing in an input → no insert (gate works)
  - Toggle "Critical path" → only critical bars and summaries visible; toggle again → all visible
  - Toggle "Milestones" → only milestones and summaries visible
  - Reduced-motion: assert no pulse rings render after milestone insert
  - Verify the new WBS column shows `1.1.2`-style numbers right-aligned

## Open design questions resolved before implementation

| Question | Resolution |
|---|---|
| Where do the toggle filters live? | In the `visibleTasks` `useMemo` (no renderer changes). Local view-state in `useScheduleStore`. |
| CPM status data source? | Existing `useSchedulerStore.cpmError + isRecalculating`. |
| AssigneeChips fits the column? | Extend with `size="sm"` and `max` props — additive, existing call sites unchanged. |
| Column localStorage version bump? | `v4` → `v5` (cleaner; falls-back-to-default merge is also safe but `v5` matches every prior column-set evolution). |
| Pulse on canvas or SVG? | SVG overlay sibling. Canvas dirty-rect rules make canvas pulses expensive. |
| Extract `useScheduleKeyboard`? | Yes, in this MR. Migrate A1's `?` handler in the same commit. |
| `parent_id` inference for milestone insert? | Walk up `visibleTasks` from the focused row; first `is_summary` ancestor wins; null = root. |
| Polite vs assertive live region? | Polite — informational, not interruption. |
| Personal notification fanout? | None exists in the codebase. Priya's concern resolved without code change. Documented in Risks. |

## No 🔴 blocking design questions remain. Ready for ux-design.
