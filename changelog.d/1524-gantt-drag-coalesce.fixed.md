- **Gantt bar-drag CPM preview per-frame cost**: dragging a task bar previously
  rebuilt the dragged task's O(N+E) downstream subgraph and shipped it across the
  Web Worker boundary on every single `pointermove` — dozens of times per day
  column — even when the snapped start date had not changed, so a large schedule
  hitched under the drag. The renderer now coalesces `drag-task-move` to snapped-
  day changes (a last-emitted guard skips redundant same-day emits; the visual
  drag shadow still tracks the cursor every frame, so the bar stays smooth), and
  the worker keeps the subgraph resident for the whole drag: it is built and sent
  once on drag start, each move sends only `{seq, newStartIso}`, and drag end
  releases it. The dependency network is invariant during a drag, so reusing the
  subgraph is sound and the preview is byte-identical to before (#1524).
