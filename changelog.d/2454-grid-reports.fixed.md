- **Grid: critical-path badges, the assignee avatar, the outline rename hint,
  the predecessors cell, and several icon-only controls now use `Tooltip`
  instead of a bare `title`**: `title` is invisible to keyboard focus,
  unreachable on touch, and ~1s delayed. The Flat/Grouped and Outline `CP`
  badges, the owner-initials avatar, the outline row's "double-click to
  rename" hint, and the outline predecessors cell now surface the same text
  through the shared `Tooltip` component (hover, focus, and touch). The
  outline expand/collapse toggle, the "Expand all" / "Collapse all" toolbar
  buttons, and the active-filter chip's remove button — all icon-only —
  now surface their existing `aria-label` the same way, so a sighted mouse
  or keyboard user gets the explanation a screen reader already had
  (#2389, #2454). The outline drag handle is deliberately left unconverted
  (see its code comment): `Tooltip` clones a trigger's own
  pointer/keyboard handlers rather than composing with them, and this
  handle's handlers are what dnd-kit uses to activate a drag.
