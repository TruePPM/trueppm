# #324 + #608 — Board groupBy and swimlanes (RECONCILED)

This spec **supersedes** both #324 and #608 as originally written. There
is one groupBy control and one swimlane renderer.

## Resolved decisions

- **D2 (axis set):** `Phase | Sprint | Assignee | Team` — the four
  options. No combined axes in v1.
- **D1 (persistence):** lives on `BoardSavedView`, not
  `useBoardToolbarPrefs`. See README D1.
- **Control affordance:** segmented control on `≥ 720px`, dropdown
  below. Segmented uses an icon + label inside each segment so it can
  shrink to icons-only at ~480–720px before collapsing.
- **Default groupBy:** `Phase` (existing behavior — unchanged for users
  who never touched the new control).

## Components

### `<BoardGroupByControl>`

```tsx
<BoardGroupByControl
  value={view.groupBy}                 // 'phase' | 'sprint' | 'assignee' | 'team'
  onChange={(g) => updateView({ groupBy: g })}
  responsive                           // collapses through 3 tiers
/>
```

Three responsive tiers:

| Viewport | Affordance |
|---|---|
| ≥ 720px | Segmented control, all 4 segments with icon + label |
| 481–720px | Segmented control, icons only with tooltip labels |
| ≤ 480px | Dropdown labeled `"Group: Phase ▾"` |

Segmented control structure (use existing primitive if present, else
build):
```
[ 📊 Phase ][ 🔁 Sprint ][ 👤 Assignee ][ 👥 Team ]
   ^selected^
```

Active segment: `background: var(--brand-primary)`,
`color: var(--neutral-text-inverse)`. Others: `background: transparent`,
`color: var(--neutral-text-secondary)`. 1px container border in
`--neutral-border`.

### `<SwimlaneRow>` — universal lane renderer

Each lane is rendered identically regardless of axis:

```tsx
<SwimlaneRow
  laneId="user-amelia"
  laneLabel="Amelia Park"
  laneMeta={{ avatar: …, role: 'Site lead', count: 12, summary: '4 in progress · 1 blocked' }}
  collapsed={collapsedLaneIds.has(laneId)}
  onCollapseToggle={() => toggleLane(laneId)}
  cards={cardsForLane}
/>
```

Lane header bar — left edge of the board:

```
┌────────────────────────────────────────────────────┐
│ ▾  👤 Amelia Park        12  4 in progress · 1 ❗ │
└────────────────────────────────────────────────────┘
   ^ collapse caret  axis-icon + label   count  summary chip
```

- Width of the header column: 200px (matches existing Phase lane meta).
- Avatar / phase chip / sprint chip swaps in axis-aware. Phase keeps
  its color stripe. Sprint shows date range `(May 11 – May 25)`.
  Assignee shows avatar + name. Team shows team color dot + name.
- Summary chip uses `.tppm-mono` for counts, `var(--neutral-text-secondary)`.
  Reduce to count-only on `≤ 480px`.

### Empty lane

When a lane contains zero cards (e.g. a sprint where this user has
nothing):
```
( italic, --text-disabled, centered )
  No cards in this lane
```

Do NOT auto-collapse empty lanes — users like seeing who has nothing.
But provide a toolbar toggle: `"Hide empty lanes"` checkbox (off by
default; persists to view).

### Ungrouped fallback

If the chosen axis has zero possible values (e.g. groupBy Sprint with
no sprints defined), the board renders as a single lane labeled
`"All cards"` with an inline empty-state nudge to define a sprint.

## Per-axis specifics

### Phase (existing — preserve)
- Lane ordering: by WBS order, not alphabetical.
- Phase color stripe stays on each lane (8px left border).

### Sprint
- Lane ordering: by start date ascending. Current sprint pinned at top
  with a small **"current"** chip. "Backlog" (no-sprint) is the last
  lane.
- Date range in mono next to the sprint name.

### Assignee
- Lane ordering: by count desc, then name asc.
- "Unassigned" lane always pinned at the bottom, dimmed.

### Team
- Lane ordering: by team display order in settings.
- Team color: small filled circle, 8px, before the name.

## Saved view → API shape

```ts
type BoardSavedView = {
  id: string;
  name: string;
  groupBy: 'phase' | 'sprint' | 'assignee' | 'team';
  collapsedLaneIds: string[];        // axis-scoped — re-derived if axis changes
  hideEmptyLanes: boolean;
  filters: { … };                    // existing
  zoom: 'compact' | 'normal' | 'roomy' | 'detail';   // see #379
  // search query NOT here (transient)
}
```

When groupBy changes, `collapsedLaneIds` resets to `[]`. (Lane IDs are
not stable across axes.)

## Mobile

- On `≤ 480px` the board already shows one column at a time. Lanes
  still stack vertically — user swipes columns horizontally inside the
  current lane, then scrolls to the next lane.
- Lane headers become sticky top within their lane's vertical region
  so they don't lose context.

## AA

- Segmented control: `role="radiogroup" aria-label="Group cards by"`.
  Each segment is `role="radio" aria-checked={…}`. Arrow keys cycle.
- Lane header collapse: `<button aria-expanded={!collapsed}
  aria-controls={`lane-body-${laneId}`}>`.
- Collapsing announces `"Lane {label} collapsed, {count} cards hidden"`.

## Migration (one-time)

On first load after this ships, for each user:
1. Read existing `useBoardToolbarPrefs.groupBy` per board.
2. Create a `BoardSavedView` named `"My view"` (private, owner = user)
   carrying that groupBy + zoom + filters.
3. Set the board's `lastViewId` to that view.
4. Mark migration done in user settings.

No-op for users who never touched the toolbar.

## Definition of done

- [ ] All 4 axes render correctly + lane ordering rules.
- [ ] Persistence routes through saved view, not toolbar prefs.
- [ ] Migration runs once per user and is idempotent.
- [ ] Empty lanes render the empty-state copy.
- [ ] `visual-specs.html → §3` matches.
