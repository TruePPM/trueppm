# #325 — Board-level activity feed

## Resolved decisions
- Surface: docked **right rail** on desktop, collapsible.
  On mobile (≤ 768px) it's a slide-up sheet (not a rail).
- Default state: collapsed. State persists on `BoardSavedView`
  (`activityPanelOpen: boolean`).
- Pagination: cursor-based infinite scroll within the panel. No "Load
  more" button — just a sentinel.

## Components

### `<BoardActivityRail>`

```tsx
<BoardActivityRail
  boardId={boardId}
  open={view.activityPanelOpen}
  onToggle={() => updateView({ activityPanelOpen: !view.activityPanelOpen })}
  filters={localFilters}                  // transient, not on view
  onFiltersChange={setLocalFilters}
/>
```

### Layout — desktop (≥ 769px)

```
┌──────────────────────────────────────────────┐──────────────┐
│ Board content                                │  Activity ◀  │
│                                              │  ──────────  │
│                                              │  [chips]     │
│                                              │  ─ today ─   │
│                                              │  event row   │
│                                              │  event row   │
│                                              │  ─ yesterday │
│                                              │  ...         │
└──────────────────────────────────────────────┴──────────────┘
                                                  ↑ 320px
```

- Width: 320px. Border-left in `--neutral-border`. No shadow.
- Collapsed state: the rail collapses to a 32px-wide vertical strip
  with a vertical "Activity" label and an unread dot if there's been
  activity since last open. Click anywhere on the strip to expand.
- Open/close animation: 160ms ease-out width transition.

### Layout — mobile (≤ 768px)

- Trigger: an "Activity" icon in the board toolbar overflow.
- Surface: bottom sheet, 80vh tall, drag handle at top. Same content.
- Closing: tap backdrop, swipe down, or close button.

### Event row

```
┌──────────────────────────────────────────┐
│ 👤 Amelia moved Pad lighting study       │
│    from In Progress → Done               │
│    Today, 2:14 PM                        │
└──────────────────────────────────────────┘
```

- Avatar (24px) left, content right.
- Actor name bold (font-weight 600); action verb regular; target as
  inline button (`<button class="link-button">…</button>`) that
  click-throughs to the card.
- Timestamp: relative ("2m ago" within 1h, "Today, HH:MM" within 24h,
  "May 23" within current year, full date beyond). In mono.
- Hovering the target button gives a faint
  `background: var(--brand-primary-light)` halo to preview the click.
- Click on the row body (NOT the actor/target buttons) opens the card.

### Day separators

`─ Today ─`, `─ Yesterday ─`, `─ May 21 ─` — small caps, secondary text,
horizontal rule on either side.

### Filter chips (top of rail body)

```
[ All ] [ Status changes ] [ Comments ] [ Mine ] [ + Actor ]
```

- "All" is the default, all-or-nothing with the other categorical chips.
- "Mine" filter: events where current user is actor.
- "+ Actor" opens a typeahead to filter by specific actor.
- Filters are **transient** — not persisted (similar reasoning to
  search: people refilter constantly).

### Pagination sentinel

At the bottom of the rendered list, a 48px-tall sentinel:
- Loading: spinner + `"Loading more…"`
- End: secondary text `"That's all the way back to {date board created}."`

### States

| State | Behavior |
|---|---|
| collapsed (default) | rail = 32px strip; unread dot if `lastReadAt < latestEventAt` |
| expanded | rail = 320px; chips + events |
| filtered | event list filtered client-side after fetching the page; if a page has 0 matches after filter, auto-fetch next page (cap 5 pages to avoid runaways) |
| empty (no events ever) | rail body shows `"No activity yet. Changes to cards on this board will appear here."` |
| loading-more | sentinel spinner |
| error | inline `"Couldn't load more activity. [Retry]"` |

## Click-through

Clicking the inline target button (card name) does NOT open the card
dialog — it focuses + highlights the card on the board (scroll into
view, brief 800ms `outline: 2px solid var(--brand-primary)` pulse).
Use the existing card-focus hook.

Clicking the row body **does** open the card dialog. This split is
intentional: "show me where it is" vs "show me what changed."

## Field-level visibility (RBAC)

`[BACKEND]` The activity feed API must apply per-field visibility
filtering. Some events (e.g. budget changes) are hidden from non-admin
roles entirely; the UI never sees them. The UI only needs to render
what the API returns.

## AA

- Rail uses `<aside role="complementary" aria-label="Board activity">`.
- Collapse button: `aria-expanded={open} aria-controls={panelId}`.
- New events arriving while panel is open: prepend with a brief
  `background: var(--brand-primary-light)` flash (200ms) and announce
  via aria-live polite: `"{actor} {action} {target}"`. Suppress
  announcements when panel is collapsed.
- Filter chips: `role="radiogroup"` for the mutually-exclusive group.
- Day separators: `<h3>` semantically (`screen-reader-only` style level
  preserved with `font-size: inherit; …`).

## Performance notes

- Initial page: 50 events. Subsequent: 50.
- Events are immutable — once fetched, never mutate; new events come
  via WebSocket subscription on the boardId channel
  (`[BACKEND]` channel name TBD).
- Filter is client-side over fetched pages. Server-side filtering
  would explode the API surface; we accept "filter may need to fetch
  another page to find matches" instead.

## Definition of done

- [ ] Rail opens/closes, persists on saved view.
- [ ] Cursor pagination works; sentinel shows correct end-state copy.
- [ ] Click-through: row opens dialog, target name highlights card.
- [ ] Mobile bottom sheet behaves correctly.
- [ ] Real-time prepend + flash + aria-live announce works.
- [ ] `visual-specs.html → §4` matches.
