# #276 — Board bulk select & bulk action bar

## Resolved decisions
- **D3 (selection model):** implicit selection — checkbox appears on
  hover/focus, no "Select mode" toggle.
- Range: Shift-click between two cards selects every card visible
  between them in **DOM order** (top-to-bottom, left-to-right). This
  ignores collapsed lanes (collapsed lane contents are not selectable).
- Toggle: ⌘/Ctrl-click flips individual cards in/out of the selection
  without disturbing the rest.
- Mobile: long-press (400ms) on a card enters a transient multi-select
  state; tapping cards toggles them. Selection auto-exits when count
  returns to 0.

## Components

### `<BoardCard>` — selection additions

```tsx
<BoardCard
  task={task}
  selected={selection.has(task.id)}
  onSelectToggle={(e) => selection.toggle(task.id, e)}
/>
```

- A 16×16 checkbox sits at the **top-left** of the card, inside the
  `padding: 10px` already there. It is `visibility: hidden` by default,
  becoming visible when:
  - the card is hovered
  - the card has keyboard focus
  - `selection.size > 0` (sticky-visible across all cards while a
    selection exists, even non-selected ones)
- The checkbox click handler MUST `stopPropagation` so the card's own
  click (open dialog) does not also fire.
- Selected card visual:
  - `border-color: var(--brand-primary)` (replaces neutral border)
  - `background: var(--brand-primary-light)`
  - keep the existing left accent stripe; it sits on top.
- Card click target reservation: top-left 24×24 region is the checkbox
  hit target; the rest opens the card dialog.

### `<ActionBar>` — sticky bulk action bar (NEW primitive)

```tsx
<ActionBar
  count={selection.size}
  onClear={selection.clear}
  actions={[
    { id: 'assign',  label: 'Assign…',  icon: 'user-plus', role: 'editor' },
    { id: 'move',    label: 'Move…',    icon: 'arrow-right', role: 'editor' },
    { id: 'archive', label: 'Archive',  icon: 'archive',     role: 'editor' },
    { id: 'delete',  label: 'Delete',   icon: 'trash',       role: 'admin',
      destructive: true },
  ]}
/>
```

- Position: `position: sticky; bottom: 16px;` inside the board scroll
  container. Centered horizontally. Width: `auto`, `max-width: calc(100% - 32px)`.
- Surface: `surface-raised`, border, **no shadow**. 8px radius.
- Layout: `[count chip] [vertical divider] [actions ...] [clear ×]`
- Count chip: `"3 selected"` — use `.tppm-mono` for the number. When
  count is huge ("All 142 cards on this board"), append a subtle
  "Select all 187 in project" link (only if there are unselected cards
  matching the current filters — same pattern as Gmail/Linear).
- Animation: slide-up 120ms ease-out on first show; slide-down on clear.
- Keyboard: when bar is visible, Esc clears selection (announces via
  aria-live).

### `<BulkActionConfirm>` — destructive confirm

Reuses the existing confirm dialog primitive. Copy templates:

- Archive: `"Archive {n} cards? You can restore them from Archived
  later."` — primary button "Archive", not destructive styling.
- Delete: `"Delete {n} cards permanently? This cannot be undone."` —
  primary button "Delete", `variant="destructive"` (red). Require user
  to type the count to confirm when n ≥ 10.

## RBAC

Lower roles see action buttons rendered but `disabled` with a tooltip
explaining why ("Assigning tasks requires Editor role"). Do NOT hide —
hiding is more confusing than disabling.

| Action | Min role |
|---|---|
| archive, move | editor |
| assign        | editor |
| delete        | admin  |

## States

| State | Trigger | Visual |
|---|---|---|
| none selected | initial | action bar hidden; checkboxes hidden |
| 1..N selected | first toggle | action bar visible; all checkboxes visible across board |
| action in progress | click action | action button → spinner, others disabled |
| partial failure | API returns per-id result | toast: `"5 of 7 archived. 2 failed: [Retry] [Details]"` — Details opens a list with reason per card |
| success | API ok | toast: `"7 archived"`; selection clears; bar hides |

## Mobile

- Long-press (400ms) on a card → haptic feedback (`navigator.vibrate(10)`)
  → enters multi-select state. The cards animate checkboxes in.
- Action bar at bottom is **always** edge-to-edge on phone (no horizontal
  margin); overflow actions go behind a `···` to keep ≤ 3 visible.
- Shift-click is replaced by "Select range" — long-press a second card
  to extend.

## AA

- Action bar has `role="region" aria-label="Bulk actions"`.
- Selection changes announce via polite live region:
  `"{n} cards selected"` (debounced 300ms so rapid shift-click doesn't
  spam).
- Each card's checkbox is `<input type="checkbox" aria-label="Select {task.title}">`.
- Destructive confirms set `aria-describedby` on the action button so
  screen readers preview the consequence.

## State machine — useBoardSelection.ts

```ts
useBoardSelection(visibleCardIds: string[]): {
  selection: Set<string>;   // sorted by visibleCardIds order
  size: number;
  has(id): boolean;
  toggle(id, modifier?: { shift?: boolean; meta?: boolean }): void;
  clear(): void;
  // Anchor for shift-range; last single toggle moves the anchor.
}
```

Anchor semantics: identical to GitHub's PR file list / Linear's issue
list. If user shift-clicks without an anchor (no prior selection), the
clicked card becomes the anchor and only that card is selected.

## Definition of done

- [ ] All four actions wire to existing single-card APIs in a loop
      with per-id error capture.
- [ ] Selection survives column reorder + card drag (selection follows
      the card by id).
- [ ] Selection clears on view switch (gantt/board/table) and on board
      filter change.
- [ ] Touch long-press works on iOS Safari + Android Chrome.
- [ ] `visual-specs.html → §1` matches.
