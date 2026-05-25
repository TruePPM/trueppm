# #379 — Board zoom (density tiers)

## Resolved decisions

- Discrete **density tiers**, not continuous scale.
- Four tiers: `compact | normal | roomy | detail`.
- Persists on `BoardSavedView` (D1).
- Mobile default: `normal`. Desktop default: `normal`.
- Do NOT model after Schedule's continuous zoom — board has no time
  axis. This is content density, not magnification.

## Tiers

| Tier | Card height | Title lines | Fields shown | Use case |
|---|---|---|---|---|
| compact | 32px | 1 (truncate) | id, title | overview / many cards |
| normal | 64px | 2 (truncate) | id, title, assignee avatar, due chip | default |
| roomy | 88px | 2 | + labels (up to 2), blocker chip | day-to-day work |
| detail | 132px | 3 | + first line of description, all labels, progress bar | review / standup |

Column widths scale with tier:

| Tier | Column min-width |
|---|---|
| compact | 156px |
| normal  | 188px (current) |
| roomy   | 220px |
| detail  | 260px |

### Compact tier visual

```
┌──────────────────────────┐
│ T-001  Pad lighting study│
└──────────────────────────┘
   ^ mono ^ truncate
```
- 32px tall, 8px horizontal padding, 6px vertical.
- ID in mono on the left, title truncated to fill the rest. No avatars,
  no chips, no left phase stripe (replaced with a 2px-wide colored bar
  on the very left edge — `border-left: 2px solid {phase.color}`).

### Detail tier visual

```
┌──────────────────────────────┐
│ T-001 · Engineering           │
│ Pad lighting study            │
│ Verify mid-bay LED replacements│
│ ─────────────────────────────│
│ 👤 Amelia  ⏱ May 28  ▰▰▰▱ 65%│
│ [field-test] [eng-mvp]        │
└──────────────────────────────┘
```

## Control

```tsx
<BoardZoomControl
  value={view.zoom}
  onChange={(z) => updateView({ zoom: z })}
/>
```

Affordance: a 4-segment icon group on the toolbar:

```
[ ▪ ][ ▪▪ ][ ▪▪▪ ][ ▪▪▪▪ ]
  compact  normal  roomy  detail
```

Active segment: `background: var(--neutral-surface-sunken)`, border
in `--neutral-border`. Hover: same sunken bg without border.

On `≤ 480px`: collapses to a single button cycling through tiers
(`[ ▪▪▾ ]` → tap cycles forward, long-press opens a popover with all
4 options).

## Keyboard

| Key | Effect |
|---|---|
| `⌘+` / `Ctrl++` | zoom out one tier (toward detail). NOT browser zoom — preventDefault if board has focus. |
| `⌘-` / `Ctrl+-` | zoom in one tier (toward compact). |
| `⌘0` / `Ctrl+0` | reset to normal. |
| `Shift+Z` | open zoom popover (alt to ⌘+/-). |

Browser-zoom hijacking: only when board view has focus AND the user is
not in an input. If outside the board (e.g. settings page), let
browser zoom pass through.

## Wheel binding

`⌘`/`Ctrl`-scroll on the board canvas zooms by one tier per "click" of
wheel delta (debounced 250ms). Otherwise, scroll behaves normally.

## Per-tier reveal / hide details

Field hiding is via CSS rules scoped to `[data-board-zoom="..."]` on
the board root:

```css
[data-board-zoom="compact"] .board-card .meta-row,
[data-board-zoom="compact"] .board-card .progress,
[data-board-zoom="compact"] .board-card .labels { display: none; }

[data-board-zoom="compact"] .board-card .title { -webkit-line-clamp: 1; }
[data-board-zoom="normal"]  .board-card .title { -webkit-line-clamp: 2; }
[data-board-zoom="roomy"]   .board-card .title { -webkit-line-clamp: 2; }
[data-board-zoom="detail"]  .board-card .title { -webkit-line-clamp: 3; }

[data-board-zoom="detail"] .board-card .description-preview { display: block; }
[data-board-zoom="detail"] .board-card .progress { display: block; }
```

No tier transitions card height with animation — snap.

## Interactions w/ other features

- Search (#323): dim treatment is identical at every tier.
- Selection (#276): checkbox sits top-left at every tier. At compact,
  it overlays the ID (ID dims when checkbox visible).
- Activity rail (#325): rail width doesn't change per tier.

## AA

- Zoom control is `role="radiogroup" aria-label="Card density"`.
  Each segment: `role="radio" aria-checked={...}`.
- Tier change announces via aria-live polite:
  `"Card density: compact"`.
- Visible field changes per tier do NOT affect the accessibility tree
  for fields that remain in the DOM — `display: none` removes them
  from the a11y tree, which is correct.

## Definition of done

- [ ] All 4 tiers render per spec.
- [ ] Persistence on saved view.
- [ ] ⌘+/- hijack only when board focused.
- [ ] Mobile cycle control works.
- [ ] No layout shift / animation jank on tier change.
- [ ] `visual-specs.html → §5` matches.
