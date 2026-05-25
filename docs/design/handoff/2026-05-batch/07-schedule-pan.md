# #491 — Schedule drag-to-pan (paired with #351 zoom)

Read alongside #351 — they form one "Schedule navigation" pass. This
spec focuses on pan affordances; #351 carries the full zoom spec.

## Resolved decisions

- Pan gestures: **Space-hold + drag**, **middle-click drag**, and
  **trackpad two-finger pan**.
- One-finger touch pans on mobile/tablet. Vertical scroll (lane-list)
  is preserved by reserving the **left edge gutter** (lane labels)
  for vertical-scroll-only. The timeline area gets both axes.
- Keyboard pan alternative: arrow keys when canvas focused (10px/tick;
  Shift+arrow = 100px/tick).
- No "grab" tool toggle in the toolbar — gestures are sufficient. A
  small first-time discoverability tooltip surfaces Space-hold on
  first hover of the canvas (per user, dismissible).

## Cursor states

| Condition | Cursor |
|---|---|
| Idle over canvas (no Space, no drag) | default arrow |
| Space pressed | `grab` (open hand) |
| Space pressed + mouse down | `grabbing` (closed hand) |
| Hovering a task bar | `pointer` even if Space pressed (Space-hold doesn't override task interactions; pan starts only on mousedown in empty canvas) |
| Middle-click drag | `grabbing` |

CSS cursors:
```css
.schedule-canvas[data-space-held="true"]      { cursor: grab; }
.schedule-canvas[data-space-held="true"][data-panning="true"] { cursor: grabbing; }
```

## Discoverability hint

First time a user mouse-enters the canvas (per `localStorage`):

```
┌────────────────────────────────────────────┐
│  Hold Space and drag to pan the timeline.  │
│                              [Got it ×]    │
└────────────────────────────────────────────┘
```

- Anchored top-center of canvas, 12px from top.
- Auto-dismiss after 6s. Stays dismissed forever once acknowledged.
- Uses `surface-raised`, border, `.tppm-mono` for the "Space" keycap
  (`<kbd>` with monospace styling).

## Gesture conflict resolution

The Schedule canvas has multiple competing inputs. Order of precedence
on mousedown:

1. **Task bar hit** → start bar drag (resize/move) — pan never starts.
2. **Empty canvas + Space held** → start pan.
3. **Empty canvas + middle button** → start pan.
4. **Empty canvas + left button without Space** → start marquee
   selection (existing).

Touch on mobile:
- One-finger drag on **empty timeline** → pan both axes.
- One-finger drag on **lane gutter (≤ 200px from left)** → vertical
  scroll only.
- One-finger drag on **task bar** → bar interaction (existing).
- Two-finger pinch → zoom (handled by #351).

## Composing with #351 zoom

- Pan + zoom share the same `viewport` state on the canvas: `{ x, y, scale }`.
- Wheel without modifier: vertical scroll.
- `⌘`/`Ctrl`-wheel: zoom (#351), anchored at cursor.
- Shift-wheel: horizontal pan.
- Trackpad two-finger native scroll: pan both axes; no zoom.
- After a pan, the next zoom must still anchor at cursor — keep math
  in `viewport` space, not screen.

## Keyboard pan

Canvas must be focusable: `<div tabIndex={0} role="application"
aria-label="Schedule timeline">`. When focused:

| Key | Effect |
|---|---|
| `←` / `→` | pan ±10px horizontally |
| `↑` / `↓` | pan ±10px vertically |
| `Shift+arrow` | pan ±100px |
| `Home` | pan to project start (x=0) |
| `End` | pan to project end |
| `Space` | hold for pan-cursor mode (does NOT also pan via keyboard) |

Selecting tasks via arrows is a separate concern owned by the existing
keyboard nav code — pan only fires when the canvas itself (not a task)
has focus.

## Edges & momentum

- Hard stop at canvas extents. No rubber-band on desktop; tasteful
  10px rubber-band with snap-back on touch.
- No momentum / inertia on desktop. iOS Safari momentum-scroll is
  preserved on touch.

## AA / non-visual feedback

- Pan does NOT announce. Way too chatty.
- "Reached start of schedule" / "Reached end of schedule" announces
  once per attempt when keyboard pan hits the edge.
- All pan gestures have keyboard equivalents (above). The discoverability
  hint is dismissible (Esc dismisses too).

## Definition of done

- [ ] Space-hold + drag pans without conflicting with bar drag/marquee.
- [ ] Middle-click drag pans.
- [ ] Trackpad two-finger pans both axes.
- [ ] Touch one-finger on timeline pans; gutter still scrolls
      vertical-only.
- [ ] Keyboard arrows + Home/End work when canvas focused.
- [ ] Zoom anchoring at cursor still correct after pan.
- [ ] First-time hint shows once per user.
