# ADR-0803: Sprint Window Bands on the Schedule Canvas

## Status

Accepted — 2026-08-05, implemented by #2738 in the same MR (verified: `computeSprintBands`
in `packages/web/src/features/schedule/sprintBands.ts`, `drawSprintBands` /
`drawSprintBandLabels` / `sprintBandFadeAlpha` in
`packages/web/src/features/schedule/engine/GanttRenderer.ts`, `setSprintBands` on the
`GanttEngine` contract, and the `Sprint window` legend entry in `ScheduleLegend.tsx`;
covered by `sprintBands.test.ts`, the band blocks in `GanttRenderer.test.ts` and
`GanttEngineImpl.test.ts`, and `e2e/schedule-sprint-bands.spec.ts`).

For 0.4, child of epic #2741 (Project Designer — declaring the hybrid split). Continues
ADR-0801, which made a row's *delivery mode* visible; this makes the sprint *window*
visible on the same timeline.

## Context

TruePPM's wedge is that a hybrid program is one plan, not two tools bolted together
(ADR-0036). #2735 made the split declarable, #2736/#2737 made it legible per row — a bar
texture, an outline gutter, a chip. What no surface showed was the sprint *cadence*: a
planner could see that phase 4 runs scrum, but not that phase 4 runs inside a two-week
window that starts on April 20 and closes on May 1, and not how that window sits against
the gated critical path feeding into it.

The obvious way to show a sprint cadence is a sprint view — a second surface, or a toolbar
toggle that swaps the Gantt for a timeline of sprints. That is the answer this ADR exists
to reject. A separate view *is* the two-tools model: the moment the cadence and the
critical path live on different screens, the planner has to hold the relationship in their
head, which is exactly the work the product claims to do for them. The hybrid claim is only
made by a picture in which both are true at once and a dependency visibly crosses between
them.

Three questions follow from putting the window on the existing canvas, and each has an
obvious wrong answer.

**1. Which rows does a band cover?** A sprint's tasks are not necessarily adjacent in a WBS
outline. "The rows of a sprint-driven subtree" is easy to say and ambiguous to implement.

**2. What does it look like?** #2727/#2737 already established a visual vocabulary for
delivery mode: violet + diagonal hatch means scrum, teal + dots means kanban, waterfall
draws nothing, and one legend explains all of it. A new region mark either extends that
vocabulary or competes with it.

**3. Where does the band paint?** The canvas is a three-layer stack with an established
order (bg: bands/grid/today; bars: bars/arrows/labels; ix: gestures). A region spanning
rows and days touches everything.

## Decision

### 1. A band is a maximal contiguous run of rows resolving to one sprint

`computeSprintBands(tasks, sprints)` resolves each row to a single sprint or to nothing,
then groups **maximal contiguous runs**. A sprint whose work is scattered across the
outline produces several bands, never one tall band spanning the rows between them.

The rejected alternative — span `min(row)…max(row)` for each sprint — is simpler and
wrong. A band is a *claim about every row it covers*. Spanning the extremes makes that
claim about rows in no sprint at all, and on a real plan (where a sprint's stories sit
under two different phases with gated work between them) it would draw a window over the
gated work it is supposed to be distinguishable from.

Row attribution mirrors `deliveryModePresentation.computeRowModes` exactly, because two
marks describing the same subtree must not disagree about what the subtree is:

- **A phase reads from its descendants**, not from its own `sprint` field. A phase whose
  branches sit in different sprints resolves to nothing and draws no band of its own; the
  bands fall to the child runs that really are single-sprint.
- **Milestones contribute nothing.** `is_milestone ⟺ delivery_mode = milestone ⟺
  duration = 0` is one coupled fact (`task_classification._classify_row`), so a gate inside
  a sprint-driven phase is a gate, not evidence the phase spans two sprints.
- **A row resolving to nothing inherits its nearest resolved ancestor.** This is the one
  place the band model goes further than the mode model, and it is load-bearing: the issue
  asks for a band spanning the rows of a *subtree*, and a subtree contains rows carrying no
  sprint of their own — the gate above, and any task nobody has pulled in yet. Without
  inheritance those rows punch holes through the middle of a band, which reads as a
  rendering fault rather than as a fact about the plan. Inheritance cannot leak across a
  disagreement, because a phase only resolves to a single sprint when every descendant
  contributes that sprint and no other.

Cancelled sprints draw nothing — they named a window that never governed work. Planned,
active and completed sprints all draw: past cadence explains the shape of the plan behind
the today line as much as the live sprint explains the shape ahead of it.

### 2. The band extends the delivery-mode vocabulary; it does not start a second one

The band is the **same violet** as `COLOR.deliveryScrum` / `--agile` (asserted by a unit
test, so the two cannot drift), hatched with the **same 45° diagonal** as the scrum bar
texture, at a wider pitch — 6px reads as texture on an 18px bar and as a solid screen over
a region hundreds of pixels tall. Its window boundaries are two **dashed** vertical rules,
closed top and bottom by hairlines, and it carries the sprint name in a pill.

The dash is not decoration. It is the band's shape channel, and it is load-bearing twice:
under `forced-colors` the band edge and the today line both resolve to `Highlight`, so a
solid 2px rule would be pixel-identical to ADR-0103's "now" mark — three indistinguishable
lines, one of which is the one a planner must not misread. And at zoom levels where the
band is too narrow for its name pill (a two-week sprint at Quarter), the dash is what keeps
hue from becoming the sole carrier.

Its legend entry goes in **the legend #2736 already extended**, beside Scrum, Kanban and
Mixed subtree. A second legend for "sprint stuff" would re-introduce, in the explanation of
the picture, precisely the two-views reading the picture exists to deny.

Colour is never the sole carrier (WCAG 1.4.1): hue, hatch, edge rules and a text label each
state the fact, so the window survives a colour-vision deficiency and a monochrome print.
Under `forced-colors` the wash is **not painted at all**. This is a correction to the
obvious reading of rule 244 ("collapse alpha tints to a solid system color"), which is a
no-op only for a fill drawn *before* what it would cover. The band draws after
`drawGridLines`, so an opaque `Canvas` rectangle would erase every day tick and row
separator inside it — the cue a high-contrast user needs most on a wide chart, deleted
precisely in the regions the feature adds. The window survives there as its `Highlight` edge
rules and a `GrayText` hatch, matching the file's shape-and-line-over-hue policy. The
general form is now web rule 295.

### 3. The region paints below the bars; its label paints among them

The band draws on the **background** layer, between the grid and the today line. That
placement is what makes the hybrid claim legible rather than merely present: every gated
bar, every dependency arrow and the critical-path frame paint on the layer above and stay
fully readable through it. Nothing forks — an arrow crosses into and out of a band exactly
as it crosses anything else, because **a band is paint, not a container**. It changes no
hit-testing, no dependency routing, and no bar geometry.

The name pill is the exception, and it is split into `drawSprintBandLabels` on the **bars**
layer for a mechanical reason: a label on the bg layer is overpainted by the first bar that
crosses it, and the bars inside a sprint band are precisely the ones that will.

Within the bars layer it paints **early** — after the hover wash, before the bars — and
that ordering is a deliberate loss. The pill straddles a row boundary, and the 3px of it
that reach into a bar box are exactly where `drawTaskBar`'s 2px inset critical-path frame
lives. Rule 235 is unambiguous that the critical frame paints last and that a channel
another mark can occlude is a dropped signal, so the bar wins the sliver and the pill keeps
the 10px inter-bar gutter its 12px text actually occupies. It straddles rather than sitting
inside the first row because a 28px row leaves 5px above the bar, which cannot hold 12px
text, and a pill placed inside would cover the first bar's leading edge — the one part of a
bar a planner reads dates from.

Geometry is re-derived from the live `GanttScaleData` on every paint, so zoom (Month →
Quarter) and the existing pan/scroll model are handled by construction: there is no cached
pixel geometry to go stale.

### 4. The Display toggle is a presentation toggle, and the fade honors reduced motion

`showSprintBands` joins `ChartRenderOptions` and the Schedule Display menu's **Chart**
section — beside dependency lines, task names and progress pills — not among the View
filters. A filter changes which work you are looking at; this changes only whether the
window behind it is drawn. Default on. Hiding it counts toward the Display badge, so nobody
is left wondering where the band went.

Both the row and its badge contribution are **gated on the project actually having a band
to draw**. A checkbox that changes nothing is a control that lies, and a badge reading
"1 hidden" on a pure waterfall plan points at the absence of a mark that could never have
appeared — the "don't leave the user wondering where it went" intent, inverted into noise.

While a label filter dims rows (ADR-0631), a band every one of whose rows is dimmed is
drawn at the same reduced alpha. `globalAlpha` is per draw call rather than per band, so
the engine partitions the bands and paints the dimmed ones in a second pass. Without this
the chart would say "ignore these rows" and "look here" about the same pixels, with the
band as the loudest thing on screen.

Bands fade in over 180ms when they first appear (`sprintBandFadeAlpha`, ease-out quadratic).
Under `prefers-reduced-motion: reduce` the engine sets alpha to 1 on the first frame and
never starts the ramp — the preference is honored by **not scheduling the animation**,
rather than by playing it faster. This is the only self-sustaining animation in the
renderer's rAF loop, and it terminates because the alpha curve saturates and the fade clock
is cleared the frame it does; an unterminated ramp would pin the compositor at 60fps, which
is exactly the failure issue #1569 removed from this loop.

Re-pushing bands during an edit does **not** restart the fade. Only a transition from
"nothing drawn" to "something drawn" is an appearance; otherwise the whole region would
flash on every keystroke in the outline.

### 5. The band reaches screen readers through the ARIA overlay

The canvas is `aria-hidden`, so the band is a sighted-only encoding — the same gap the
delivery-mode suffix on `buildTaskAriaLabel` closes for #2727. `buildTaskAriaLabel` takes an
optional `SprintBand`, and rows no band covers stay silent about sprints.

It takes the **whole band, not just its name**, because membership is not the read.
What a sighted user takes from a band is where the bar sits relative to the window's
edges — a bar whose right end crosses the right rule is a commitment that overruns its
sprint, and that is the reason to look. So the label names the window's dates and appends
`, finishes after the sprint window` when the task's finish is past it. The overlay's row
node also carries the untruncated sprint name as its `title`: a canvas has no tooltip, so a
name the pill had to clip has no sighted recovery path otherwise (rule 255).

## Consequences

- The Schedule shows the gated critical path and the sprint cadence in one picture, with
  dependencies visibly crossing between them. This is the visual half of the hybrid
  declaration; without it #2735/#2736/#2737 are a popover whose result is invisible.
- `computeSprintBands` is a second consumer of the "phase reads from its descendants" rule.
  If that rule changes, `deliveryModePresentation.ts` and `sprintBands.ts` must change
  together, or a row's chip and its band will disagree about which subtree it belongs to.
- `useSprints` reads only the first page (`PAGE_SIZE = 50`, no `page_size` query param on
  `SprintViewSet`). A project with more than 50 sprints silently draws no band for the
  overflow. The band model degrades correctly rather than wrongly — an unknown sprint id
  breaks the run instead of extending it — but the truncation itself is a real gap. Fixing
  it means paginating `useSprints`, which is out of scope here.
- Bands are addressed by row index into the array handed to `setTasks`. Any host that
  pushes bands must recompute them from the same array it pushes rows from; the read-only
  program schedule view passes none and draws none.

## Alternatives considered

**A separate sprint view or a Gantt/sprint toggle.** Rejected as the core of the problem,
not a solution to it — see Context. A toggle that swaps one for the other is the two-tools
model with a shorter path between the tools.

**A full-height column per sprint, like a timescale band.** Simpler to compute (no row
attribution at all) and wrong: it claims every row in the project belongs to the sprint,
which on a hybrid plan is false for most of them. The issue's own wording — "spanning the
rows of a sprint-driven subtree" — is the correction.

**A DOM overlay rather than canvas paint.** `MonteCarloGanttMarkers` is the precedent, and
it would have given free text and free accessibility. Rejected because the band must sit
*under* the bars: a DOM sibling of the canvas can only sit above or below the entire stack,
so the band would either hide the bars or be hidden by them. Splitting the label onto the
bars layer gets the layering right, and the ARIA overlay covers accessibility (§5).

**Distinguishing sprint state visually (active vs. planned vs. completed).** Deferred. It
is cheap to add and easy to over-read — a planner would reasonably infer that a differently
drawn band means differently governed work, which is not what sprint state means. If it
lands it should be a deliberate design decision, not a free consequence of having the state
in hand.
