Add actual-date overlay rendering to the canvas Gantt renderer (#80).
`drawActualDateBar` draws a 6px dashed bar below the planned bar when
`actualStart` or `actualFinish` is set — red for late tasks, green for
early, slate for in-progress. `drawScheduleVarianceBadge` renders a "+3d"
/ "-2d" label to the right of the finish edge. Both are wired into
`GanttEngineImpl._paintTaskAt` after the main bar draw. 11 new renderer
unit tests; exports new `GHOST_BAR_HEIGHT = 6` constant (rule 14). (#80)
