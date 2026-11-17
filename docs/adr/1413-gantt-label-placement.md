# ADR-1413: Canvas Gantt label placement — measure, detect, suppress

- **Status:** Accepted (2026-11-17)
- **Date:** 2026-11-17
- **Issues:** #2434
- **Related:** ADR-0063 (dependency routing rules), #2422 (label defaults), #2096 (label halo), #1539 (text-width cache)

## Context

ADR-0063 specifies how dependency arrows route and how they treat each other. Task-name
labels had no specification: they knew about nothing. #2422 removed the observed
collisions by default (Grid suppresses on-bar names; Timeline defaults to the aligned
gutter), but a user who opts back into free-floating labels still got arrowheads
terminating inside text.

## Decision

Labels are the lowest-priority paint on the bars layer. Priority, highest first:

1. Bars (labels are placed relative to them and never overlap their own bar).
2. Dependency arrows: arrowheads, and vertical segments that pass *through* a label's
   row band.
3. Labels already drawn this frame for another row.
4. The label being placed.

`paintDependencyLayout` publishes the frame's arrowhead boxes and pass-through vertical
segments as keep-outs (content-space rectangles) and resets the per-frame label history.
`drawTaskBarLabel` measures the run it is about to paint (through the shared text-width
cache, #1539) and **suppresses** it when its rectangle overlaps a keep-out or a label
already drawn for another row.

**Suppression, not truncation or repositioning.** The outline carries every name, so an
absent label costs less than a struck or half-drawn one. Existing width capping against
the viewport edge is unchanged; collision is a separate, later test.

## Deliberate non-keep-outs

- A task's **own** exit stub and trunk origin leave at row-center, exactly where its label
  sits. Treating them as obstacles would suppress the label of every task with a
  successor. The label halo (#2096) knocks them out of the glyphs instead. Only vertical
  segments strictly between the two end rows count (each end shrinks by half a row).
- Horizontal segments and Bezier (SS/FF/SF) bodies are not keep-outs; their arrowheads are.

## Consequences

- A label may disappear at some scroll offsets when an arrowhead lands on it; it returns
  when the arrow moves. The row's name is always available in the outline.
- Cost is O(labels x keep-outs) per frame over the viewport-culled path set.
- A frame boundary is the call to `paintDependencyLayout`; the engine always paints
  arrows before labels.
