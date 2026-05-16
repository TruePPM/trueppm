# ADR-0063: Gantt Dependency Arrow Routing Rules

## Status

Accepted (2026-05-16)

## Context

The Gantt canvas renderer at `packages/web/src/features/schedule/engine/GanttRenderer.ts` has been iterated on multiple times for issue #466 with mixed results: arrows penetrating bars, long horizontal back-runs across the chart, giant loops around the chart, missing arrows when geometry was tight, and tangled visuals when many arrows shared a horizontal corridor.

A consolidated rendering specification was provided (`docs/gantt-rendering-spec-final.md`, see source under `~/Downloads/gantt-rendering-spec-final.md`). It defines 14 routing rules (R1–R14), three geometry states (VALID / INFERRED / INVALID), a merge-junction algorithm with three-tier fallback, and 12 test fixtures.

Three reviews were run before adopting the spec:

- **Voice-of-customer panel** — 6.0/10 average across six personas. Three cross-persona blockers: ghost bars read as real tasks; R11 silently suppresses rollup-to-rollup dependencies; no SS/FF/SF type support.
- **Architect review** — five blocking questions, primarily around (1) ownership of `geometry_status`, (2) the algorithmic compatibility of the spec's column-sweep with TruePPM's existing simple-L renderer, (3) snapshot-diff testing for canvas (not SVG) output, (4) summary rollups as endpoints, and (5) merge-junction retargeting of paths.
- **UX review** — would not ship the spec as-is. Mandatory mods: brand-color overrides (red task bar fill conflicts with completion teal; amber milestone/anchored-marker tokens are not in the design system), anchored-marker x-stacking bug, accessibility on the `⊘ inferred` label and 8px badge glyphs.

This ADR captures the routing-engine and merge-junction subset (the spec's Phase 3 + Phase 4). Visual-rendering constants, geometry-state classification, and the test-fixture/snapshot apparatus are tracked separately so this branch stays scoped to issue #466.

## Decision

### Scope

This ADR governs **dependency arrow routing only** — the spec's Phase 3 (routing engine, rules R1–R14) and Phase 4 (merge junctions). The following are out of scope for this ADR and are tracked as follow-ups:

- **Phase 1** (visual constants audit / color reconciliation) — separate branch.
- **Phase 2** (geometry states VALID / INFERRED / INVALID, ghost bar, anchored marker, suppressed-dependency badges) — separate branch; requires the API decision below.
- **Phase 5** (CPM polish) — separate branch.
- **Phase 6** (12 test fixtures + snapshot diffing) — separate branch; depends on a decision on canvas snapshot strategy (see follow-up #1).

### Overrides of the spec

Three places the spec is overridden, with rationale.

**Override 1: Summary rollups CAN be dependency endpoints.** Spec R11 says rollups should not be source or target; the renderer should suppress and warn. We override: rollup-rooted arrows render normally because waterfall PMs use phase-to-phase dependencies as the primary relationship (existing `packages/web/CLAUDE.md` rule 75). Rollups remain in the obstacle list for routing other arrows. Per-arrow filtering removes source/target from obstacles as usual.

**Override 2: Task bar fill is not red `#A32D2D`.** Spec §3.1 specifies red 600 for normal task bars. We keep TruePPM's existing palette (`barNormal = #3B82F6` blue, `barCritical = #B91C1C` red for critical path, `barComplete = #166534` green). Red is reserved for critical-path emphasis, not normal bars. Reconciliation of the broader color table is deferred to the Phase 1 separate branch.

**Override 3: Arrow color is unified to charcoal regardless of critical-path state.** Spec §3.1 says all dependency arrows render in `#444441`. We keep that. Critical-path state is conveyed by the red bar fill, not the arrow stroke. `arrowNormal` and `arrowCritical` tokens both resolve to charcoal in `packages/web/src/features/schedule/engine/GanttRenderer.ts`.

### Routing engine — rules adopted

The 14 spec rules are adopted with the modifications below.

- **R1 (no segment penetrates any hard obstacle).** Adopted. Every horizontal or vertical segment is tested against AABB of every bar, summary rollup, and milestone except the arrow's own source and target.

- **R2 (horizontal run-in ≥ 8 px).** Adopted. Final segment is horizontal and at least `APPROACH_STUB = 8` long. Arrowhead never sits at a path corner.

- **R3 (horizontal exit stub ≥ 5 px).** Adopted. First segment is horizontal and at least `EXIT_STUB = 5` long.

- **R4 (milestone entry/exit vertices differ).** Adopted. For FS arrows the incoming side is the LEFT vertex flank; outgoing is the RIGHT vertex flank. Entry and exit vertices on the same milestone are guaranteed different because FS sources always exit right and FS targets always enter left. Top/bottom vertex exits for upward arrows are deferred (R8 backward arrows are rare in our charts).

- **R5 (multi-predecessor milestones use merge junction).** Adopted but **broadened**: merge junction fires for any target with 2+ FS predecessors, not only milestones (so a leaf task with 2+ predecessors also merges). Junction sits at `(target.barLeft − 14, target.y)` for milestones, same offset for leaf targets. Predecessor lines terminate at `(junction.x − 2, junction.y)` without arrowheads. A single trunk arrow with the only arrowhead runs from junction to target's entry edge. Junction = white halo (radius 4) + charcoal dot (radius 3), drawn LAST so it sits on top of line endcaps.

- **R6 (canonical 5-segment path).** Adopted. Canonical shape: exit stub → V drop in clear column → H traverse in clear row gutter → V alignment → H run-in. Path collapses to 3 segments when no gutter traverse is needed.

- **R7 (arrows never share a vertical lane).** Deferred. Lane-occupancy tracking is added in a follow-up when arrow density requires it; current charts are sparse enough that single-column overlap is rare. Tracked as follow-up #3.

- **R8 (forward arrows preferred; flag backward).** Adopted in spirit. Backward FS arrows route through the same algorithm without special casing. Console warning on first occurrence in a render is deferred.

- **R9 (descent column search direction).** Adopted with a tight cap. Forward arrows search `[exitX, target.x_start − 8]` for a clear column. When no column in that range is clear, the column at `exitX` is used and the V drop may detour around the first blocker per R12.

- **R10 (text labels as soft obstacles).** Deferred. Label AABBs are not added to the obstacle list in this ADR. Labels are drawn AFTER arrows (rule 71 z-order in `GanttEngineImpl._paintAllBars`), so labels visually cover any arrow line that runs underneath. Tracked as follow-up #4.

- **R11 (inflated rollup AABBs + rollup endpoint suppression).** Adopted for the AABB inflation half — summary rollups inflate by `milestoneHalfDiag` on both axes in the obstacle list to capture diamond-endcap overhang. The endpoint suppression half is **overridden** (see Override 1).

- **R12 (gutter dogleg for stacked sequential tasks).** Adopted. When `target.y > source.y` and `target.x_start ≤ source.x_end + EXIT_STUB`, route through the gutter midline between source and target rows. The gutter Y sits at `(source.y_bottom + target.y_top) / 2`, in the 10-px gap between adjacent 18-px bars in a 28-px row. If a blocker bar at an intermediate row overlaps `target.x_start − APPROACH_STUB`, route around the blocker's LEFT side (south → west around → south → east).

- **R13 (merge junction fallback ladder).** Adopted Fallback 1 (shift junction leftward in 6-px increments up to 60 px). Fallback 2 (gutter row) and Fallback 3 (staggered approach) deferred — log a warning if Fallback 1 exhausts. Tracked as follow-up #5.

- **R14 (geometry-based dependency suppression).** Deferred. This requires geometry-state classification (Phase 2), which is out of scope for this ADR. Tracked as follow-up #2.

### Junction rule (codified — DO NOT DEVIATE)

A junction dot renders only where **3 or more distinct arrow LINES meet at a single (x, y)** — TRUE convergences. Counting segments is the wrong lens: a T-junction has three segments but only two visible lines (one passing through, one branching off), which is indistinguishable from any other Manhattan corner. A dot there reads as noise rather than signal. This applies to:

1. **Merge (convergence)** — 2+ predecessor arrow lines arrive at one point and a single trunk line continues to the target = 3+ distinct lines meeting. Junction at `min(maxPredecessorExitX, tipX − arrowSize − APPROACH_STUB)`. Predecessors terminate AT the dot (no individual arrowheads). A single trunk arrow with the only arrowhead runs east to the target.

2. **Split (divergence)** — **no dot.** When a source has 2+ outgoing FS arrows sharing a V-drop column, each turn-off is a T-junction (one V line passing through + one H line branching off east). Two visible lines = corner, not junction. The deepest target's turn-off is the same shape. Splits draw no dots.

3. **Cross-arrow intersection** — **no dot (deferred).** Two independent arrows crossing at one (x, y) is two lines crossing, not three meeting. A line-bridge or dash break is the appropriate visual cue here, not a dot. Tracked as a follow-up.

**Constraint**: a junction must NOT land inside a task bar, summary rollup, or milestone diamond. If the computed position falls on an object, push it to the nearest row gutter.

**Visual**: outer halo (radius `MERGE_HALO_RADIUS=4`, `palette.surface` fill) + inner dot (radius `MERGE_DOT_RADIUS=3`, stroke color). Drawn LAST in z-order so it sits on top of every line endcap.

### Merge junction algorithm

Per spec §7.3 with the modifications above:

1. Group all FS links by `targetId`. Targets with 2+ predecessors enter the merge-junction code path.
2. Junction position is the **actual line-convergence point**, not a fixed offset from target. Specifically `junctionX = min(maxPredecessorExitX, tipX − arrowSize − APPROACH_STUB)` where `maxPredecessorExitX` is the rightmost `src.barRight + EXIT_STUB` across all valid predecessors. The first term places the dot where the LAST V drops onto the shared trunk Y — i.e. the X where ALL predecessor lines have merged into one. The second term caps it so the trunk shaft preceding the arrowhead stays ≥ APPROACH_STUB.
3. Each predecessor draws its FULL path via `calculateDependencyPath` with `targetEntryX = junction.x − 2`. The path terminates at the junction's stop point with no arrowhead.
4. A single trunk arrow runs straight east from the junction to the target's arrowhead base (`tipX − arrowSize`). The trunk shaft is at least APPROACH_STUB long, satisfying R2. Arrowhead at `tipX`.
5. Junction halo (radius 4, palette.surface fill) + dot (radius 3, stroke color) drawn last so it covers all line endcaps.
6. Junction marks the single point of convergence. T-junction dots at predecessor branch points are **not** drawn (lines pass through, do not converge at those points).

### Selection emphasis

When source OR target is in `engine.selectedTaskIds`, the arrow uses `palette.selectionRing` stroke at 2.5 px. Other arrows hold 2 px. This is independent of the spec but kept from the existing implementation.

### SS / FF / SF arrows

Out of scope. Continue to render with cubic Bézier curves with 40-px control-point offsets (existing behavior). Spec is silent on non-FS routing. Tracked as follow-up #6.

## Consequences

- The simple-L-shape fallback that was in the renderer before this ADR is replaced by the 5-segment canonical path with detour-around-blocker per R12.
- The merge-junction code already handled multi-predecessor milestones; this ADR broadens it to non-milestone targets and removes any T-junction dots that were drawn during recent iterations on this branch.
- Geometry-state classification, suppression badges, and the visual-token reconciliation work move to separate branches. This means the existing blue placeholder for tasks with missing dates and the existing red task bar fill remain until those branches land — call that out explicitly in the MR description.
- Tests: existing `GanttRenderer.test.ts` continues to assert on `lineTo` counts per arrow. The 12 spec fixtures with snapshot-diff are deferred to a follow-up (see follow-up #1).

## Alternatives considered

- **Adopt the spec literally including red task bars and R11 rollup suppression.** Rejected — VoC and UX both flagged these as customer-facing regressions.
- **Reject the spec and continue iterating on the existing simple-L renderer.** Rejected — the existing renderer has documented gaps (Q2 in the architect review; the "snake game" complaint from the user about overlapping Hs). The spec's R6 canonical 5-segment path with R12 gutter dogleg is the right structural choice.
- **Implement all 6 phases in this branch.** Rejected — Phase 2 requires Django API changes; Phase 6 requires a canvas-snapshot testing infrastructure decision. Scoping to Phase 3+4 keeps issue #466 closeable.

## Follow-ups

1. **Canvas snapshot testing.** Decide between `node-canvas` + pixel-diff, Playwright screenshot diffs, or structural waypoint assertions. Required before Phase 6 fixtures can ship. Open issue.
2. **Geometry states (Phase 2).** Django API adds `geometry_status`, `inferred_start_date`, `inferred_end_date` to the Task serializer. Renderer adds ghost bar + anchored marker visuals + suppression badges + R14 filtering. Open issue.
3. **R7 lane occupancy.** Track per-column claims so multi-arrow descents in nearby columns are forced apart by ≥ 6 px. Open issue.
4. **R10 label soft obstacles.** Add label AABBs to obstacle list with a cost-function fallback (not absolute rejection). Open issue.
5. **R13 fallback ladder full coverage.** Implement Fallback 2 (gutter row) and Fallback 3 (staggered approach). Open issue.
6. **SS / FF / SF Manhattan routing.** Decide whether to keep Bézier or convert to Manhattan with separate rules. Open issue.
7. **Visual token reconciliation (Phase 1).** Reconcile spec §3.1/§3.2 against existing `COLOR` and dimension constants. Pure visual cleanup, no behavior change. Open issue.

## References

- Spec: `docs/specs/gantt-rendering-spec.md` (1038 lines, sections 1–12 + completion criteria)
- Existing rule: `packages/web/CLAUDE.md` rule 75 (rollup endpoints, charcoal arrow color)
- Existing rule: `packages/web/CLAUDE.md` rule 14 (bar / summary / milestone / baseline dimensions)
- Prior ADR: ADR-0014 (canvas rendering and planned-start constraint)
- VoC panel: six TruePPM personas, 6.0/10 average, three cross-persona blockers
- Architect review: five blocking design questions, three architectural risks, three ADR-worthy decisions
- UX review: would not ship as-is; brand-color and accessibility mods required before customer-facing release
- Issue: #466
