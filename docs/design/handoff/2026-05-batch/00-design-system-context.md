# Design system context

Read this first. Every spec in this package assumes the conventions below.

## Tokens

Source: `apps/web/src/styles/tokens.css` (or wherever the project's design
tokens live). The values below are authoritative; if the codebase has
drifted, reconcile *to* these values, not away from them.

```
--brand-primary:        #1C6B3A      forest green — primary actions, focus, selection
--brand-primary-dark:   #145229      pressed / hover-darken
--brand-primary-light:  #D4EDDA      selection tint, on-track soft bg
--brand-accent:         #E8A020      amber — warnings, at-risk, accent stripe
--brand-accent-dark:    #C17A10
--brand-accent-light:   #FFF3CD

--semantic-critical:    #B91C1C      destructive, overallocated > 100%
--semantic-warning:     #E8A020      same as accent — at-risk
--semantic-on-track:    #166534      same family as primary

--neutral-surface:           255 255 255   (rgb triplet for opacity math)
--neutral-surface-raised:    250 249 247
--neutral-surface-sunken:    235 235 235
--neutral-border:            212 210 206
--neutral-text-primary:      26 25 23
--neutral-text-secondary:    107 105 101
--neutral-text-disabled:     154 152 148
```

**Rules:**
- No drop shadows for elevation. Use border + sunken/raised surface pairs.
- Brand green is *the* selection / active color. Don't introduce blue.
- Amber means "needs attention, not broken." Red means "broken or
  destructive."

## Typography

- UI: `Inter`, 14px base. 13px for dense table cells. 12px for chips/meta.
- Mono: `JetBrains Mono` — used for IDs (`T-001`), dates (`2026-05-25`),
  counts in chips (`12 / 40`), and any tabular number. Apply via
  `.tppm-mono` utility.
- Numerics in non-mono contexts: `font-variant-numeric: tabular-nums`.

## Accessibility baseline (WCAG 2.1 AA — applies to every ticket)

- All interactive elements reachable by keyboard in document order.
- Focus ring: 2px brand-primary outer ring, 2px white inner ring (use the
  existing `.focus-ring` utility — `box-shadow: 0 0 0 2px white,
  0 0 0 4px var(--brand-primary)`).
- Color is **never** the only carrier of state. Pair tint with icon,
  label, or pattern (dotted border = at-risk; solid red border + ❗icon =
  critical).
- Live regions for async/result announcements: `aria-live="polite"` for
  counts and progress; `aria-live="assertive"` only for hard errors.
- Drag interactions ALWAYS have a non-drag keyboard alternative (per-
  spec). aria-grabbed / aria-dropeffect are deprecated — use button +
  menu + announcements instead.
- Hit targets: 44×44px CSS minimum on touch viewports (≤ 768px); 32×32
  on desktop is acceptable.

## File path conventions (where each thing lives)

```
apps/web/src/
  components/
    board/                  — Board view + its toolbar + cards
      BoardToolbar.tsx      — groupBy, zoom, search, filters live here
      BoardCard.tsx
      BoardGrid.tsx
    schedule/               — Schedule (Gantt) view
      ScheduleCanvas.tsx
      ScheduleToolbar.tsx
    import/                 — Import modal + wizards (NEW per #68)
      ImportModal.tsx       — base, format-agnostic
      ImportDropzone.tsx
      ImportProgress.tsx
      ImportResults.tsx
      formats/
        MppImport.tsx       — #68
        CsvXlsxImport.tsx   — #111 (3-step wizard)
        RiskCsvImport.tsx   — #223 (later; same pattern)
    primitives/
      Checkbox.tsx
      Popover.tsx
      Toast.tsx
      ActionBar.tsx         — NEW — sticky bottom action bar (#276)
      OverallocBadge.tsx    — NEW — shared (#330, #489)
      OverallocBanner.tsx   — NEW — shared
  hooks/
    useBoardToolbarPrefs.ts   — exists; will be downgraded per D1
    useBoardSelection.ts      — NEW — multi-select state (#276)
    useDependencyHover.ts     — existing handoff
  features/
    notes/                  — NEW (#740, #745, #748)
      NotesPanel.tsx
      NoteComposer.tsx
      MentionPicker.tsx
      MyMentionsFeed.tsx
    activity/               — NEW (#325)
      BoardActivityRail.tsx
```

## Glossary (these terms appear across the specs)

- **Card** — a task as it appears on the board (`BoardCard`).
- **Lane** — a horizontal row on the board, e.g. "Engineering phase".
- **Column** — a vertical bucket, e.g. "In Progress".
- **Swimlane** — same as lane; spec uses "swimlane" when emphasizing the
  grouping axis (Assignee, Team, etc.) rather than the phase rows.
- **Phase** — top-level WBS grouping (Engineering, Procurement, ...).
- **Sprint** — time-boxed iteration. Cards belong to ≤1 active sprint.
- **Saved view** — a stored configuration of board state (groupBy, zoom,
  filters, etc.). See D1 in README.
- **Allocation %** — a person's committed time fraction on a project
  (0–100%). Aggregated across projects; > 100% = overallocated.

## Touch / responsive breakpoints

- `≤ 480px` — phone. Board → single column at a time (column-swipe
  navigation, NOT all columns visible).
- `481–768px` — tablet portrait. Board → 2 columns visible, h-scroll.
- `≥ 769px` — desktop. All columns visible.

The specs use "mobile" loosely to mean `≤ 768px` unless they say "phone."
