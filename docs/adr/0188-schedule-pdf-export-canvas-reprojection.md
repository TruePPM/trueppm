# ADR-0188: Schedule PDF Export — Re-project the Canvas Gantt to a Static Print Surface

## Status
Accepted

## Context
ADR-0159 established that TruePPM PDF export is **client-side** (`html-to-image` +
`jspdf`), rendering an off-screen **print layout** component and rasterizing it — not
a server render (WeasyPrint / headless Chromium). The board export (#326) shipped on
that pattern: `BoardPrintLayout` is a static DOM projection of the already-loaded
board, captured by `html-to-image.toPng`.

Epic #79 (children #1436–#1440) asks for the same client-side artifact for the
**project schedule**: a one-page Gantt PDF (Layout A, #1437) and a 3-page report
(Layout B, #1439), driven by an in-app options dialog (#1438), on shared infra
(#1436). ADR-0159 names the *delivery mechanism* (client-side, html-to-image, jsPDF)
but not the *source* of the pixels — for the board, the source is the live board's
own DOM-shaped data. The schedule is different in one decisive way, and that
difference is a genuinely new architectural decision ADR-0159 does not cover.

**The schedule Gantt is a custom `<canvas>` renderer**
(`packages/web/src/features/schedule/engine/`, `GanttRenderer.ts`), not a DOM tree.
Investigation of the renderer establishes three facts that make capturing the live
canvas the wrong approach:

1. **It is viewport-clipped.** Every draw call is offset by `scrollLeft` / `scrollTop`
   and bounded by `ctx.canvas.width`; sticky regions use `ctx.clip()`. The canvas
   holds only the *currently scrolled-into-view window* of the timeline, never the
   full project span. A print artifact needs the **whole timeline**.
2. **It is dark-themed and zoom-bound.** The live renderer paints the dark palette
   (`COLOR_DARK`) at the user's current `pxPerDay`. The print artifact must be the
   **light** print theme at a **fixed print width**, independent of live zoom.
3. **`html-to-image` on a live canvas would, at best, copy the one viewport frame** —
   wrong on extent, theme, and scale simultaneously. There is no capture path from
   the live canvas that yields the required artifact.

The renderer does, however, expose a **pure, reusable coordinate layer**:
`GanttScaleData` plus `buildScaleData` / `buildScaleDataFromPxPerDay` / `dateToLeft` /
`dateToRight` / `leftToDate` / `parseUTCDate` / `headerUnitsForPxPerDay` (all exported
from `engine/index.ts`). These are framework-agnostic date↔pixel math with no canvas
or React dependency — exactly what a static layout needs to place bars, milestones,
gridlines, and dependency-arrow endpoints.

## Decision
**Do not capture the live canvas. Re-project the schedule into a separate static
SVG/DOM print surface (`SchedulePrintLayout`) that reuses the engine's pure geometry
layer, then rasterize that surface with the ADR-0159 client-side pipeline.**

Concretely:

- `SchedulePrintLayout.tsx` (mirrors `BoardPrintLayout.tsx`) is an off-screen,
  non-interactive React projection at a **fixed print width**. It owns its **own**
  `GanttScaleData`, built from the full project span and a `pxPerDay` sized to fit the
  print width — **not** the live engine's scroll/zoom state. Bars, milestone diamonds,
  the data-date line, and week gridlines are positioned with the shared
  `dateToLeft` / `dateToRight` helpers (no `scrollLeft` term — the print surface draws
  the full content extent at offset 0).
- The Gantt rows render as **DOM** (the WBS-indented label column, bar rectangles, %
  fill) and the **dependency arrows render as an `<svg>` overlay** (`<path>` FS
  connectors with arrowheads), so the entire surface is real DOM/SVG that
  `html-to-image` captures faithfully — and so the **PDF text layer stays
  selectable/searchable** (a canvas raster would not).
- The geometry contract (`GanttScaleData` + the `dateTo*` helpers) becomes a
  **public dependency of the print path**. Per the `GanttEngine.ts` versioning note,
  this cross-module reuse is recorded here so a future change to the geometry layer
  knows the print surface depends on it.
- **Theme derivation, not new colors.** The print surface uses the **light** Design
  System token values for the *same semantic roles* the canvas paints: critical →
  `semantic-critical`, on-track/complete → `semantic-on-track`, milestone →
  `brand-accent`, summary → neutral ink. No new color tokens are invented at export;
  only the resolved light values differ from the live dark canvas (issue #1436).

`exportSchedulePdf.ts` mirrors `exportBoardPdf.ts` (dynamic-import the two libs,
rasterize once, slice the tall bitmap into landscape page bands) and **extends** it
with two schedule-specific needs: a **cancel + progress signal** (the #1438
generation states), and **horizontal week-boundary banding** for wide timelines (the
board only bands vertically by page height).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Re-project to static SVG/DOM, reuse geometry layer (chosen)** | Full timeline, light theme, fixed width — all three correct by construction; selectable PDF text layer; reuses tested `GanttScaleData` math; no engine refactor; same ADR-0159 capture pipeline | A second, parallel render of the schedule to keep visually faithful to the canvas; arrow + summary-bar geometry re-derived for SVG |
| **Capture the live `<canvas>` via html-to-image** | "Reuse" the existing renderer | Yields one viewport frame only — wrong extent, dark theme, live zoom; no text layer; cannot produce a full-timeline light-theme artifact at all |
| **Add a headless/off-screen render mode to `GanttRenderer`** (draw the full timeline to an `OffscreenCanvas` at print width/light palette) | One renderer, pixel-identical to live | Large new surface on a 85 KB renderer; raster-only (no selectable text, fails #79's text-layer requirement); print pagination + light theme leak print concerns into the interactive engine; far heavier than reusing the geometry helpers |
| **Server-side render (WeasyPrint / Chromium)** | Pixel-stable | Already rejected by ADR-0159; new endpoint → RBAC/perf/audit surface; must re-derive schedule + CPM server-side |

## Consequences
- **Easier**: no API/migration/permission surface (stays within ADR-0159); the
  geometry layer is already pure and tested; the board export gives a proven three-file
  shape to mirror; the DOM/SVG surface yields a selectable PDF text layer for free.
- **Harder**: `SchedulePrintLayout` is a *second* renderer of the schedule and must be
  kept visually faithful to the canvas as the engine evolves — mitigated by sharing
  the single source of geometry truth (`GanttScaleData`) so date/position drift is
  impossible; only *styling* can drift, which a Layout-A Playwright golden guards.
- **Risks**: dependency-arrow routing for dense graphs is non-trivial in SVG
  (orthogonal routing + channel stagger, #1440); the print `pxPerDay` fit must keep a
  ~150-activity schedule under the single-pass rasterizer's canvas-size ceiling
  (the `RASTER_TIMEOUT` error path in #1438 is the explicit fallback when it doesn't).

## Implementation Notes
- P3M layer: **Programs and Projects** (single-project schedule artifact)
- Affected packages: **web** only
- Migration required: **no**
- API changes: **no** (projects already-loaded schedule + existing forecast/CPM data)
- OSS or Enterprise: **OSS** — the Apache-2.0 edition seam (`scheduleExportEdition.ts`)
  mirrors `boardExportEdition.ts`; no runtime enterprise import.

### Relationship to ADR-0159
This ADR **extends, does not supersede,** ADR-0159. ADR-0159 owns the *delivery*
decision (client-side, html-to-image + jspdf, off-screen layout, edition seam). This
ADR owns the schedule-specific *source* decision (re-project the canvas to static
SVG/DOM via the engine geometry layer; never capture the live canvas) and the two
helper extensions (cancel/progress, horizontal week banding).

### Durable Execution
Inherits ADR-0159's "all N/A" stance: pure client-side render, no server dispatch, no
outbox, no idempotency surface. A generation error surfaces in the #1438 dialog
(machine code + retry); nothing is persisted, so re-running is the only recovery.
