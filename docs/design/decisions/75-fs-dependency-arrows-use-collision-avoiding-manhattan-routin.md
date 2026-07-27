# Rule 75 — FS dependency arrows use collision-avoiding Manhattan routing with merge junctions

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Visual Design (Canvas)*

**FS dependency arrows use collision-avoiding Manhattan routing with merge junctions** (issue #466,
ADR-0063). Spec lives in `docs/adr/0063-gantt-dependency-routing-rules.md` and next to the code
in `GanttRenderer.ts` (header comment for `calculateDependencyPath`). Behavior contract:
- **Pure Manhattan polyline.** No Bézier, no diagonals. 3 to 7 segments. Every segment is
  strictly horizontal or strictly vertical.
- **Stubs.** Exit stub from source's right edge ≥ `EXIT_STUB` (5px). Approach stub from the last
  Manhattan waypoint to the arrowhead base ≥ `APPROACH_STUB` (8px). The router targets the
  arrowhead base (`tipX − arrowSize`), NOT the bar/diamond edge, so the visible stroked shaft
  before the arrowhead is always APPROACH_STUB long. Arrowhead never sits at a path corner.
- **Algorithm — decision tree** (ADR-0063 §"Routing engine"):
  1. Same row: 3 segments — exit stub → H → run-in.
  2. Stacked-sequential (target.x ≤ source.barRight + EXIT_STUB): 5-segment gutter dogleg
     per R12 — exit stub → V to row-gap gutter → H along gutter → V to target row → run-in.
  3. V at exit column blocked by a non-source/non-target bar: 5-segment left-detour —
     exit stub → V to gutter → H west past blocker's left edge → V south past blocker →
     run-in. Used for cases like milestone → child-of-phase where the exit column
     lands inside the containing summary's X range.
  4. Otherwise: collapsed 3-segment canonical L — exit stub → V at exit column straight
     to target row → run-in.
- **Arrow color is charcoal, always.** `arrowNormal` and `arrowCritical` both resolve to
  `#444441` (light) / `#B8B5AE` (dark). Critical-path state is conveyed by the red BAR fill
  (rule 73), NOT by the arrow. Previous "critical arrow = red" rendered red arrows visually
  merging with red bars where they crossed (issue #466 gap P0-1).
- **Summary rollups CAN be arrow endpoints.** Waterfall PMs use phase-to-phase dependencies
  as the primary relationship; suppressing them hides the user's working structure. Rollups
  are also obstacles for routing other arrows.
- **Milestone flank rules.** Incoming arrows enter on the LEFT vertex flank (tip at
  `cx − milestoneHalfDiag`). Outgoing arrows exit from the RIGHT edge (= right vertex of the
  milestone). Entry and exit vertices on a single milestone naturally differ because FS sources
  always exit right and FS targets always enter left.
- **JUNCTION RULE (codified, do not deviate).** A junction dot renders only where 3 OR MORE
  distinct arrow LINES meet at one (x, y) — TRUE convergences. Counting segments is the wrong
  lens: a T-junction has 3 segments but is visually indistinguishable from any Manhattan
  corner (one line passing through + one branching off), and a dot there reads as noise. The
  rule applies to:
  - **Merge** (convergence): 2+ predecessor lines arrive at one point and a single trunk
    line continues to the target = 3+ distinct lines meeting. Junction at
    `min(maxPredecessorExitX, tipX − arrowSize − APPROACH_STUB)`. Each predecessor terminates
    AT the junction (no arrowhead). A single trunk arrow with the only arrowhead runs east
    to the target.
  - **Split** (divergence) — **NO dot.** When a source has 2+ outgoing arrows that share a V
    column, each "intermediate" turn-off is a T-junction (one V line passing through + one H
    branching off east). Two visible lines, not three — corner, not junction. The deepest
    target's turn-off is the same (V terminating + H branching off). Splits draw no dots.
  - **Cross-arrow intersections** — bridge hop per ADR-0063 Rule 15 Type A. Two independent
    arrows crossing at one (x, y) get a 10-px-wide, 6-px-tall quadratic Bézier arc on the
    "over" segment (horizontal by default). Not a dot. Implemented via the collect-then-draw
    refactor in `drawDependencyArrows`: every Manhattan path is collected first, then
    `detectHops()` walks every pair of paths to record orthogonal interior crossings, then
    `drawPathWithHops()` strokes each path with arcs inserted at hop positions. Bézier
    (SS/FF/SF) arrows skip detection — Bézier-vs-Manhattan crossings are out of scope for v1.
  - **One arrow terminating on another arrow's path** — small T-junction dot per Rule 15
    Type B (spec adopted; implementation deferred). Halo radius 5 + dot radius 4 —
    intentionally one pixel smaller than the merge marker to reinforce the hierarchy.
  - **Junction visual (merge).** Outer halo (radius `MERGE_HALO_RADIUS=6`, `palette.surface`)
    + inner dot (radius `MERGE_DOT_RADIUS=5`, stroke color). Drawn LAST so it sits on top of
    every line endcap. If a junction would land inside a task bar's body, push it to the
    nearest row gutter (it should never sit ON an object). Original spec values were 4/3;
    bumped to 6/5 after canvas testing — 4/3 was visually subordinate to the 2-px arrow
    stroke and easy to miss on dense charts. See ADR-0063 "Junction rule (codified)" for
    rationale and Rule 15.2 for the full size hierarchy.
- **Selection emphasis.** When the source OR target is in `engine.selectedTaskIds`, the arrow
  uses `palette.selectionRing` stroke at 2.5px. Other arrows hold 2px.
- **SS / FF / SF unchanged** — cubic Bézier with 40px control-point offsets. Same charcoal
  stroke. Manhattan routing collapses these to U-shapes that cross the source bar; Bézier
  reads cleaner for same-edge links and matches MS Project's convention.
- **Source connection dot is removed** — the arrow tail is the affordance; the dot added noise.
- **Ancestors of the arrow's target are transparent obstacles** (ADR-0063 Override 4). A
  summary rollup is a visual aggregation of its children, not a real wall — an arrow into a
  deep descendant descends straight through the rollup's body instead of doing a chart-spanning
  U-detour around the entire summary bar. Source-side descendants stay as walls; only
  target-side ancestors are excluded.
- **Redundant FS edges to descendants of a summary target are suppressed at render** (ADR-0063
  Override 5). When a source has FS to both summary S AND one or more descendants of S, only
  the summary edge renders. Schedule semantics are unchanged (data still has both edges, CPM
  still uses both); the renderer drops the descendant edges to declutter. Example: milestone
  → phase 4 and milestone → daddy3 (daddy3 ∈ phase 4) — only milestone → phase 4 renders.
- **Lag annotation and click-to-delete on the arrow** are out of scope for v1.
