- **Schedule: open task details by double-clicking a bar**: double-clicking a task
  bar, milestone, or summary rollup on the Schedule timeline now opens its detail
  drawer. The engine already emitted a `task-open` event on double-click, but the
  Schedule view never subscribed to it, so the only affordance over a bar was the
  `grab` cursor for dragging — there was no way to reach a task's details from the
  timeline. A quiet "Double-click a task to open its details" hint was added to the
  schedule legend for discoverability. Single-click still selects (ring +
  dependency-chain highlight) without opening the drawer.
