# ADR-0280: Risk-on-border task bars for the interactive canvas Gantt

## Status
Accepted

## Context
The interactive canvas Gantt renderer (`packages/web/src/features/schedule/engine/GanttRenderer.ts`)
colored each task bar's **fill** by task state, with the critical path carried by a
red fill. `barFillColor()` resolved that state by precedence:

```ts
if (task.isExternal) return _palette.textSecondary;
if (task.isSummary) return _palette.barSummary;
if (task.isComplete || task.progress >= 100) return _palette.barComplete; // green
if (task.isCritical) return _palette.barCritical;                          // red
return _palette.barNormal;                                                 // blue
```

Because completion is checked **before** criticality, a completed critical task
rendered as a solid green bar — the red critical signal was never painted. On a
mostly-complete schedule (e.g. 14 of 19 tasks done) nearly every bar reads green
and the critical path disappears from the live view, directly contradicting the
KPI strip's critical-task count. This is the same defect that ADR-0277 fixed on the
**PDF export** surface; this ADR brings the interactive canvas into line.

The canvas differs from the PDF in one way that matters to the fix: its fill
already carries a **richer state language** (blue in-progress / green complete /
gray external), which users rely on live, whereas the PDF's fill only ever encoded
progress. So the canvas cannot adopt the PDF's exact "fill = green progress" model
without flattening a distinction users depend on.

## Decision
Adopt the ADR-0277 **principle** — *risk lives on the border, not the fill* — while
keeping the canvas's existing state fill:

- **`barFillColor()` no longer special-cases critical.** The fill is purely task
  state (external → muted, summary → dark gray, complete → sage-600 green, else →
  blue). Criticality is removed from the fill entirely.
- **The critical path is a 2px red border frame** drawn in `drawTaskBar()` for
  non-external, non-summary critical tasks (`barCritical` = #B91C1C light /
  #F87171 dark). A completed critical task is therefore a **green bar in a red
  frame** — the critical signal can never again be masked by completion. As a 2px
  non-text border the frame clears WCAG 1.4.11 (≥3:1) on the surface in both modes,
  and criticality remains backed non-color by the task-list red dot and the
  critical-path-only filter (WCAG 1.4.1).
- **The progress overlay draws before the borders** so the risk frame and selection
  ring paint crisply on top of the 30% tint rather than being dimmed by it.
- **The selection ring nests inside the critical frame, and the frame is drawn last.**
  The navy `selectionRing` (#1B2A4A) normally draws as a 2px inset ring; when a red
  critical frame is present and the bar is at least `MIN_NEST_WIDTH` (12px) wide, it
  nests one step further in (inset 3px, 1.5px wide) so a selected critical bar shows
  a red frame outside and a navy ring inside. Below 12px the two concentric rings
  would collide, so the ring falls back to the standard inset — and because the
  critical frame is painted *after* the selection ring, **risk outranks selection**:
  a narrow selected critical bar keeps its red frame instead of losing it under the
  navy ring (a dropped-signal bug the UX review caught). This extends the ADR-0103
  D4 distinguishability set to four independent visual axes — complete = sage fill,
  critical = red frame, selected = navy ring, today = sage line — with a clear
  priority order (risk > selection) for when two must share a narrow bar.
- **The `%` completion chip drops its critical-specific treatment.** The old
  white-text/white-pill chip existed to read on a red critical fill; with no bar
  red-filled anymore, every chip pairs with the surface treatment (dark translucent
  pill + white text), which already handles the blue and green fills.
- **The legend's `CriticalSwatch`** changes from a solid red bar to a red-framed
  neutral bar so it teaches the new treatment.

The alternative — a straight port of the PDF model (fill = green progress, one hue)
— was rejected because it would discard the canvas's blue-in-progress vs
green-complete state language. Consistency across surfaces is at the level of the
*principle* (risk on the frame), not identical pixels; each surface keeps the fill
that fits it.

At-risk / on-track **amber** bands (present on the PDF) are out of scope here: the
canvas `Task` model exposes only `isCritical` (binary), not a graded risk band, so
a v1 on the canvas is a critical-only red frame. Graded bands can follow once the
band data is plumbed to canvas tasks.

## Consequences
- `barFillColor` is simpler and no longer returns `barCritical`; that token now
  reaches the bar surface only as the border stroke and, separately, as the
  late-actuals stroke in `drawActualDateBar` (#80, untouched).
- Unit tests assert the new contract directly (fill = state, critical = border
  stroke, completed-critical shows both, selection nesting), which is a tighter
  guarantee than the previous fill-color assertion.
- Recorded as a web rule in `packages/web/CLAUDE.md`. Complements ADR-0277 (PDF
  export) and ADR-0103 (distinguishability triad).
