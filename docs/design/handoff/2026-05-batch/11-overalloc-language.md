# #330 + #489 + #747 — Overallocation visual language (shared)

ONE pattern, consumed in two places:

- **#330** — pre-assignment warning, inline in the assignee picker.
- **#489 / #747** — Team-tab allocation table in project settings.

Both share `<OverallocBadge>` and `<OverallocBanner>` primitives.
Don't draw bespoke ones in each surface.

## The signal

A person's allocation is `Σ allocPct` across active projects. Three
tiers:

| Total | Tier | Visual |
|---|---|---|
| ≤ 100% | `ok` | no badge, neutral text |
| 101% – 120% | `over` | amber badge `+15%` |
| > 120% | `critical` | red badge `+34%` |

Default thresholds are 100/120; admins can tune in workspace settings
(future). The components accept thresholds as props but render with
the defaults if omitted.

## Components

### `<OverallocBadge>`

Inline pill that goes next to a name.

```tsx
<OverallocBadge
  percent={amelia.totalAllocPct}    // 134 — not the over amount
  size="sm" | "md"
/>
```

Visuals:
- `ok` — renders nothing (returns null).
- `over` — `100%`-relative diff: text `"+{percent - 100}%"`, pill
  `background: var(--brand-accent-light)`, `color: var(--brand-accent-dark)`,
  `border: 1px solid var(--brand-accent)`. `.tppm-mono`. Always include
  a leading `⚠️` glyph (icon, not emoji — use the existing `warning`
  lucide icon at 12px) so color isn't the only carrier.
- `critical` — text `"+{n}%"`, pill bg `var(--sem-critical-bg)`,
  color `var(--semantic-critical)`, border same. Leading `❗` icon
  (`alert-octagon` from lucide).

Sizes:
- `sm` — height 18px, padding 0 6px, font 11px. Used inside lists and
  picker rows.
- `md` — height 22px, padding 2px 8px, font 12px. Used in table rows.

### `<OverallocBanner>`

Block-level panel for the assignee picker (#330) and table-summary
positions.

```tsx
<OverallocBanner
  person={person}
  byProjects={[
    { id, name, allocPct },          // sorted desc by allocPct
    ...
  ]}
  variant="over" | "critical"
  onOverride?={() => commitAssign()}  // when used in assignee picker
  overrideLabel?="Assign anyway"
/>
```

```
┌──────────────────────────────────────────────┐
│ ⚠  Amelia is at 134% across 3 projects.     │
│                                              │
│    Artemis IV   60%                          │
│    Helios       50%                          │
│    Backstop     24%                          │
│                                              │
│    Adding this card would push to 142%.      │
│                                              │
│              [ Cancel ]  [ Assign anyway ]   │
└──────────────────────────────────────────────┘
```

- Background: `var(--brand-accent-light)` for over / `var(--sem-critical-bg)`
  for critical.
- Border-left: 3px solid accent-dark / critical.
- Icon top-left, sentence top right.
- Project list is a 3-col mini-grid `(name | bar | percent)`. Bar is
  a 60px-wide proportional fill (`--brand-accent` for over,
  `--semantic-critical` for critical). Total across projects sums in
  bold below.
- The "Adding this card would push to ..." sentence only renders in
  the picker context — when this component is used in the table for
  summary, the projected delta is omitted.

## #330 — Pre-assignment warning placement

```
┌─────────────────────────────────────┐
│  Assignee                           │
│  [ Amelia Park ▾ ]                  │
│                                     │
│  ┌─────────────────────────────────┐│
│  │ ⚠  Amelia at 134% (3 projects)  ││   ← <OverallocBanner> here
│  │   ...                           ││
│  │   [ Assign anyway ]             ││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

- The banner sits **inside the assignee picker popover** (or inside
  the dialog when the picker is inline), directly below the selected
  person. NOT a toast, NOT a separate modal.
- "Assign anyway" commits the selection. "Cancel" deselects. The
  picker stays open so the user can choose someone else.
- The warning evaluates against the **target card**'s projected
  contribution. If the card has no explicit alloc % (board cards),
  count it as a flat 10% during the current sprint (`[BACKEND]`
  policy — confirm). For Schedule tasks with explicit durations,
  contribution is the task's daily share over its date range.

### Dismissal vs override

- "Assign anyway" = override → save selection, banner clears.
- Choosing a different person clears the banner; choosing an over-
  allocated different person replaces it with their banner.
- The override is recorded in the activity feed
  (`"Diego overrode overalloc warning when assigning Amelia"`).

### Mobile picker

The picker becomes a bottom sheet. The banner renders identically,
just constrained to viewport width. Buttons stack vertically below
360px.

## #489 / #747 — Team-tab allocation table

Project settings → "Team" tab.

### Table layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Team                                                           │
│  Allocate the people working on this project.                   │
│                                                                 │
│  ┌──────────────┬─────────┬──────────────────────────┬───────┐  │
│  │ Person       │  This % │ Other allocations        │       │  │
│  ├──────────────┼─────────┼──────────────────────────┼───────┤  │
│  │ 👤 Amelia    │  60%    │ Helios 50  Backstop 24   │ +34% │  │
│  │              │  [────]  │  •••••••                 │ over │  │
│  ├──────────────┼─────────┼──────────────────────────┼───────┤  │
│  │ 👤 Diego     │  40%    │ Helios 30                 │  ok   │  │
│  │              │  [───]   │  •••                     │       │  │
│  ├──────────────┼─────────┼──────────────────────────┼───────┤  │
│  │ + Add person                                              │  │
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│  Total committed: 100%   (1 person over 100%)                   │
└─────────────────────────────────────────────────────────────────┘
```

- Row layout: avatar + name | this-project % (editable inline) | other
  allocations summary | overalloc badge.
- "This %" cell is inline-editable: click → text input + slider hybrid:
  ```
  [60] %  ▭▭▭▭▭▭▱▱▱▱
  ```
  Number input with stepper, slider underneath. Enter or blur commits.
  Esc cancels.
- The "Other allocations" cell shows up to 3 chip-style entries
  (project + %), truncated with "+N more" tooltip. Below the chips, a
  60px stacked bar visualizes the total.
- The overalloc cell renders `<OverallocBadge size="md">` for over/
  critical rows, blank for ok.
- "+ Add person" row at the bottom: typeahead → person picker → adds
  row with default 0% editing focused.
- Remove person: row-hover reveals a `×` at the far right. Confirm
  inline: `"Remove Amelia from this project? Her allocation here
  drops to 0%."`

### Empty state

```
No one is allocated yet.
[ + Add the first person ]
```

### Validation

- Per-row: if "This %" > 100 → border critical, helper text "Can't
  allocate more than 100% to one project."
- Per-row total (this + other): if > 100 → row shows the over badge.
  Save still allowed — over-allocation is a warning, never a block.
- Project total bar at the bottom: sums of "This %" across rows. Can
  exceed 100% (you can over-staff a project). No warning on totals;
  it's a project decision.

### Mobile (≤ 768px)

Stacked card layout per person:

```
┌────────────────────────────────────┐
│ 👤 Amelia Park             +34% ⚠ │
│ This project   [60] %   ▭▭▭▭▭▭▱▱  │
│ Other          Helios 50, Backstop 24│
└────────────────────────────────────┘
```

Inline edit becomes a tap-to-edit modal sheet on mobile (number
keypad).

## AA

- OverallocBadge: pill is `<span role="img" aria-label="Overallocated
  by 34 percent">`. Carry the icon AND the percent in the aria-label.
- OverallocBanner: `role="region" aria-label="Allocation warning"`.
- Inline edit cell: `<input type="number" aria-label="Allocation
  percent for Amelia Park on Artemis IV" min=0 max=200 step=5>`.
  Accept up to 200 (over-allocations are common) but render the over
  badge above 100.
- Override button is the only positive-action button in the banner;
  Cancel is secondary.
- Live announce on override:
  `"Assigned Amelia despite overallocation."`

## Shared utility

```ts
function classifyAllocation(totalPct: number, thresholds = { over: 100, critical: 120 }) {
  if (totalPct > thresholds.critical) return 'critical';
  if (totalPct > thresholds.over)     return 'over';
  return 'ok';
}
```

Put in `hooks/useAllocation.ts` and export from one place.

## Definition of done

- [ ] `<OverallocBadge>` and `<OverallocBanner>` exist in
      `components/primitives/` and are imported by both #330 and
      #489's surfaces.
- [ ] Assignee picker shows banner inline when warranted.
- [ ] "Assign anyway" commits + records to activity.
- [ ] Team tab table renders, inline-edits, validates per-row.
- [ ] Mobile stacked layout works.
- [ ] aria-labels carry the signal.
- [ ] `visual-specs.html → §9` matches.
