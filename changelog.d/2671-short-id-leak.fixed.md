- **Raw hex task/sprint IDs on more surfaces**: `T-0000000A`-style raw
  identifiers still leaked onto the Product Backlog (list rows, story/epic
  drawers, mobile grooming cards), the global "Log time" quick-log popover
  (including its search, where typing a task's real number never matched),
  My Work's task row and per-row log-time popover, the mobile Schedule
  view, the cross-project relation and dependency pickers, and every Sprint
  reference (`SP-0000000A` instead of `SP-10`) across Planning, Board,
  My Work's active-sprint card, and the sprint carryover preview. All of
  these now render the server-decoded reference (`T-10` / `ENG-2026-10` /
  `SP-10`), matching the fix already shipped for board cards.
