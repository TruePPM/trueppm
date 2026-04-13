- **Gantt dependency arrows**: SS (Start→Start), FF (Finish→Finish), and SF
  (Start→Finish) link types now render as cubic Bézier arrows on the canvas
  timeline in addition to the existing FS type. Critical-path coloring applies
  to all four types. `TaskLink` now includes a `lag` field (days).
- **Task detail drawer**: clicking the `⋯` icon on any Gantt task row (visible
  on hover, always visible when the row is selected) opens a right-side drawer
  (480 px desktop / 85 vh bottom sheet mobile) for managing predecessors and
  successors. Each dependency row shows the related task name, a dep-type
  selector (FS/SS/FF/SF), and a lag input. Predecessors and successors can be
  added via a task picker and removed with the delete button. The CPM engine
  recalculates and moves dependent tasks automatically after any dependency
  change.
- **Gantt task start date**: the task bar now uses the later of `planned_start`
  (user constraint) and `early_start` (CPM result), so dependency-driven delays
  are reflected immediately even before the next CPM run completes.
