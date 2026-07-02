- **Gantt engine idle-repaint and full-range redraw perf**: the canvas Gantt's
  animation-frame loop previously kept scheduling itself and clearing the
  interaction canvas on every frame forever, even with no drag/pan/animation in
  flight — an open, static schedule permanently pinned the compositor at 60fps
  and drained battery on laptops/mobile. The loop now parks itself once there is
  no pending repaint and no active drag/resize gesture, and re-arms only when a
  mutation or gesture actually needs a new frame. Separately, the background
  grid-line and timeline-header draw passes walked the entire project date range
  on every scroll/pan frame regardless of what was actually visible — on a
  multi-year project at day/week zoom this was the largest per-frame cost in the
  scroll path. Both now clip their day-by-day walk to the visible viewport
  window instead of the full project span (#1569, #1570).
