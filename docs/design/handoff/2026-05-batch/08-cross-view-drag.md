# #318 — Drag BACKLOG card → Schedule (cross-view)

Hardest interaction in the batch. Read all of this spec before writing
any code.

## Resolved decisions

- **D4 (layout):** Schedule view gains a docked **Backlog Rail** on its
  left edge. The Board view is NOT shown side-by-side with the Schedule;
  the rail is a project-scoped, filterable subset of backlog cards.
- **Schedule transition:** dropping a card schedules it — its status
  auto-transitions BACKLOG → NOT_STARTED, dates derived from the drop
  position.
- **Date snapping:** drop snaps to the nearest day boundary in the
  current zoom level. If the lane targets a specific resource lane,
  that resource is auto-assigned (replacing any prior assignee — confirm
  inline first).
- **Non-drag path:** primary on mobile, also available on desktop. A
  "Schedule…" action in the card's row menu opens a date+lane picker.

## Layout

### Desktop (≥ 1024px)

```
┌─────────┬──────────────────────────────────────────────┐
│ Backlog │   May 18 ─ May 25 ─ Jun 1 ─ Jun 8 ─ Jun 15   │
│ ─────── │ ┌─────────────────────────────────────────┐  │
│ [search]│ │ Engineering    ▓▓▓▓▓                   │  │
│ [filter]│ │ Procurement       ▓▓▓▓▓▓               │  │
│ ─────── │ │ Pad Ops              ▓▓▓                │  │
│ ▢ T-001 │ └─────────────────────────────────────────┘  │
│ ▢ T-014 │                                              │
│ ▢ T-020 │                                              │
│ ▢ T-031 │                                              │
│ ─────── │                                              │
│ ◀ Hide  │                                              │
└─────────┘──────────────────────────────────────────────┘
   240px              schedule canvas
```

- Rail width: 240px. Collapse to 32px strip with a vertical "Backlog"
  label.
- Rail content top→bottom:
  1. Header `"Backlog"` + count `"4"` (mono).
  2. Search field (delegates to the same matcher as #323; scope =
     backlog cards in this project).
  3. Filter row: phase chip + assignee chip (typeahead chips, like
     existing filter).
  4. Scrolling card list. Cards render at `compact` density (see #379).
  5. Footer: "Hide rail" toggle.

### Tablet (768–1023px)

- Rail starts collapsed by default. Tap to expand; it overlays the
  canvas with a backdrop until tap-out.

### Phone (≤ 768px)

- No rail. The "Backlog" tab in the bottom nav opens the rail as a
  full-screen sheet. Schedule view never shows the rail inline.
- Cross-view drag doesn't exist on phone (no hover). The non-drag
  "Schedule…" action is the only path.

## Drag interaction (desktop)

### Drag affordance on rail cards

- `cursor: grab` on the card body, `grabbing` while held.
- `aria-grabbed` NOT used (deprecated). Use the `dragstart` /
  `dragend` events.
- A faint grip glyph (`⠿`) at the right edge of the rail card on hover.

### Drop targets

The canvas is one big drop target. As the cursor moves over it during
drag, render two overlays:

1. **Day column highlight** — a 1-day-wide vertical band tinted
   `background: rgba(28, 107, 58, 0.08)` showing where the start date
   will land.
2. **Row highlight** — the lane (resource or phase) the cursor is over
   gets a `background: rgba(28, 107, 58, 0.06)`.
3. **Ghost bar** — a dashed bar of the card's default duration
   (existing `card.estimateDays || 3`) drawn from the snap-day across
   the highlighted row. Use `.tppm-mono` for the dates inside the
   ghost: `"May 28 – Jun 2 · 5d"`.

### Valid vs invalid drops

- Valid: anywhere on the canvas inside the schedule's date range.
- Invalid: outside the date range (e.g. dragged left of project
  start). Ghost bar gets a critical border + a small badge
  `"Outside project dates"`. Cursor `not-allowed`. Drop is no-op.

### Drop confirmation

If the drop lane targets a resource (groupBy Assignee on Schedule), and
the card has an existing assignee that is different, show an inline
confirm at the drop point:

```
┌─────────────────────────────────┐
│  Reassign to Amelia Park?       │
│  Currently: Diego R.            │
│        [ Cancel ]  [ Confirm ]  │
└─────────────────────────────────┘
```

Otherwise drop commits immediately. After commit, a brief toast at
bottom-center: `"Scheduled T-001 for May 28. [Undo]"`. Undo window 8s.

### Undo

Undo reverts:
- Status: NOT_STARTED → BACKLOG
- Schedule dates: cleared
- Auto-assignee (if changed): restored
- Position: card reappears in the rail at the top.

## Non-drag path (mobile primary, desktop alt)

### Trigger
- Rail card row menu → "Schedule…"
- Card dialog → "Schedule" button (existing; this just becomes the
  non-drag fallback)

### `<ScheduleCardDialog>`

```
┌─────────────────────────────────────┐
│  Schedule T-001                     │
│  Pad lighting study                 │
│  ─────────────────────────────────  │
│  Start date     [ May 28 ▾ ]        │
│  Duration       [   5 d  ▾ ]        │
│  Assignee       [ Amelia Park ▾ ]   │
│                  ⚠ Overallocated    │
│                                     │
│             [ Cancel ]  [ Schedule ]│
└─────────────────────────────────────┘
```

- Date picker: native on touch, custom on desktop.
- Duration: number stepper (1–90).
- Assignee picker: reuses `<AssigneePicker>` which surfaces the
  overallocation warning from #330.

## States

| State | Trigger | UI |
|---|---|---|
| idle | — | rail collapsed/expanded; canvas as usual |
| dragging | dragstart on rail card | day col + row highlight; ghost bar |
| valid-drop hover | cursor over canvas in range | ghost solid 60% opacity; canvas accepts drop |
| invalid-drop | outside range / forbidden lane | ghost dashed critical border |
| scheduled | drop or dialog submit | card disappears from rail, appears on canvas; toast |
| undo | toast Undo clicked | reversed; card returns to rail; second toast `"Restored to backlog"` |
| reassign confirm | dropped into different-assignee lane | inline confirm at drop point |

## aria-live announcements (drag + drop)

- On dragstart: `"Dragging T-001, Pad lighting study"`.
- During drag, when entering a new day column:
  `"Drop here to schedule for May 28"`.
- Debounce 200ms so SR isn't spammed every pixel.
- On drop: `"Scheduled T-001 for May 28, assigned to Amelia Park"`.
- On invalid: `"Invalid drop — outside project dates"` (assertive).

## Touch alternative (tablet)

If a user long-presses a rail card on a touch device that DOES have
hover (rare — hybrid laptops), tabletDragger kicks in: card lifts,
cursor disables, finger drags ghost. Treat as desktop drag from there.

For pure-touch phone: no drag at all. The action menu's "Schedule…"
opens the dialog.

## API + state

`[BACKEND]` Endpoint: `POST /api/projects/{id}/schedule-card`
body: `{ cardId, startDate, durationDays, assigneeId? }`
returns the updated card. Frontend updates two caches:
- backlog list (remove)
- schedule (insert)

Optimistic UI: remove from rail on drop, insert ghost bar on canvas.
On 4xx/5xx: undo + show toast `"Couldn't schedule. {error}"`.

## Definition of done

- [ ] Backlog rail renders in Schedule view, collapsible, persists.
- [ ] Drag from rail to canvas works with day + row highlights.
- [ ] Ghost bar shows correct duration + dates.
- [ ] Invalid drops show critical state and no-op.
- [ ] Reassign confirm fires when applicable.
- [ ] Undo restores all state, including assignee.
- [ ] Dialog path works on phone and desktop.
- [ ] aria-live announcements fire on the right events.
- [ ] `visual-specs.html → §6` matches.
