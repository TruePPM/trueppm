- **Schedule: several `title="…"` explanations now use `Tooltip` instead**:
  `title` is invisible to keyboard focus, unreachable on touch, and ~1s
  delayed. The task drawer's critical-path `CP` badge, expand button, and
  over-allocated-assignee note; the task list row's properties button; the
  task strip's computed-start value and free-float chip; the Float/Free
  float column headers; the "invalid link" and "not active yet" notices;
  and the how-to bar's dismiss button now surface their explanation through
  the shared `Tooltip` component (hover, focus, and touch). Several other
  `title`s that only restated an already-visible label or accessible name
  (a pinned/decision marker, a deleted-attachment placeholder, a disabled
  mention option, the Monte Carlo "Rerun" button) were removed outright as
  pure duplication (#2389, #2454).
