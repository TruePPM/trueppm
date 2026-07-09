# ADR-0289: Selectable text layer for the schedule/board PDF export

## Status
Accepted

## Context
The client-side schedule/board PDF export (ADR-0159, ADR-0188, ADR-0233, ADR-0276)
rasterizes an off-screen print surface (`SchedulePrintLayout` / `BoardPrintLayout`)
to a single flat PNG per page via `html-to-image` `toPng()` and embeds it with
jsPDF `addImage()`. The resulting document has **no selectable/searchable text, no
reading order, and no alt structure** — only the "Sheet n of N" / "Page n of N"
captions are real PDF text (ADR-0276). ADR-0188 explicitly deferred a tagged pipeline
to issue #1687.

This is a genuine accessibility defect of the exported artifact: a screen reader
cannot perceive it and text cannot be selected or copied (WCAG 1.1.1, 1.3.1, 4.1.2 as
they apply to the produced document). Issue #1687 acceptance:

1. Exported schedule/board PDF carries a **selectable text layer** for row labels,
   KPI values, and the critical-path chain.
2. Document has a **logical reading order**.

**P3M layer:** Programs and Projects (Operations) — a PM/contributor exporting their
own schedule/board. Pure **OSS**, no boundary implications.

**Forces**
- The pipeline is deliberately **client-side and offline-first** (ADR-0159 rejects
  server-side/headless-Chromium rendering). Any fix must not reintroduce a backend.
- jsPDF (4.2.1, already a dependency) does **not** emit a PDF/UA StructTreeRoot
  (tagged-PDF structure tree). It *does* support text rendering **mode 3
  ("invisible")** — the classic OCR/scanned-PDF text-layer pattern — verified in its
  bundled type declarations.
- Pagination is already non-trivial: three strategies (week-snapped horizontal
  banding, row-aware vertical pagination with re-composited headers, plain fixed-pixel
  banding). Any text layer must ride the **same** per-page source→dest transform each
  strategy already computes, or it will drift off the visible glyphs.
- The schedule print surface positions rows on a deterministic grid (`ROW_H`
  constant); the board stacks **variable-height** cards. A geometry source that works
  for both must be **measured**, not computed from constants.

## Decision
Add a **selectable invisible-text overlay** on top of the existing raster — the raster
remains the visual layer; a real, selectable jsPDF text run is stamped over each
content element using its measured DOM geometry, positioned through each page's
existing scale/offset transform.

1. **Opt-in content markers.** Content-bearing nodes in the two print layouts are
   marked `data-print-text="<role>"` (roles: `masthead`, `kpi`, `row`, `cp`, `footer`,
   `column`, `lane`, `card`). Only marked nodes contribute selectable text — decorative
   swatches, `title`-tooltip-only bars, and duplicate strings are excluded. Markers are
   placed in **DOM document order = logical reading order** (masthead → KPIs → rows →
   critical-path chain → footer).

2. **Shared primitive** `packages/web/src/features/export/pdfTextLayer.ts`:
   - `collectPrintTextRuns(root)` — walks `[data-print-text]` in document order,
     returning each run's trimmed text + bounding box **relative to the print root, in
     CSS px** (`getBoundingClientRect`). Runs with empty text or a **degenerate
     (zero-area) rect** (jsdom / an unmeasured surface) are skipped, so callers without
     layout simply get no text layer and the raster still exports unchanged.
   - `stampTextLayerForPage(pdf, runs, ratio, placement)` — for the region of the
     raster shown on a page (`{srcX,srcY,srcW,srcH}` in image px) placed at
     (`destX,destY`) points at `scale` pt/img-px, stamps every intersecting run as
     **invisible** (`renderingMode: 'invisible'`, `baseline: 'top'`), fitting the font
     to the run's box height. `typeof`-guarded so the jsPDF test double is unaffected.
   - `setPrintDocumentMetadata(pdf, {title})` — sets the document `/Title` and
     `/Lang` (`en-US`) via `setProperties`/`setLanguage` (both guarded). `/Lang` is the
     one PDF/UA-adjacent property jsPDF *can* emit and matters most for AT.

3. **Wiring.** Both `exportSchedulePdf` and `exportBoardPdf` collect runs once after
   the single rasterize, then call `stampTextLayerForPage` at each `addImage`
   placement — for every pagination branch (single page, vertical pages with header
   offset, week-snapped label-strip + chart band, plain banding, board banding).
   Because the label strip is repeated per sheet, its `row` runs are stamped per sheet
   (matching the repeated visual); a run straddling a page break is stamped on both
   pages (harmless for invisible search text).

Runs are emitted in collection (document) order, so the PDF content stream carries a
logical text order — the practical reading-order guarantee jsPDF can make without a
structure tree.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Invisible-text overlay on the raster (chosen)** | Stays client-side/offline; reuses the raster and every existing pagination transform; one small shared module; jsPDF-native, no new deps; works for fixed-pitch schedule rows and variable board cards via measured rects | Not a true tagged PDF (no StructTreeRoot); reading order is content-stream order, not a semantic tree; per-page geometry threading touches each pagination branch |
| **Full PDF/UA tagged pipeline in jsPDF** | Real structure tree, headings, table semantics | jsPDF cannot emit a StructTreeRoot; would need a different lib or a fork — not viable client-side |
| **Server-side DOM→tagged-PDF (WeasyPrint / headless Chromium)** | Genuinely tagged, correct reading order and roles | Reverses ADR-0159 (rejects backend rendering); breaks offline-first; heavy operational surface; large rebuild |
| **Vector re-render (draw text with jsPDF instead of rasterizing)** | Fully selectable, crisp | Throws away the pixel-accurate Gantt bars/arrows/SVG the raster captures; a from-scratch vector Gantt renderer — far larger than #1687 |

## Consequences
- **Easier:** exported PDFs are searchable/selectable and expose row labels, KPI
  values, and the CP chain to assistive tech with a logical order and a document
  language. Marketing/docs deep-links to demo exports become copy-able.
- **Harder:** every pagination branch now also threads a text-placement call; new
  content in a print layout must carry a `data-print-text` marker to be selectable
  (documented in a frontend rule).
- **Risks:** invisible text can misalign if the placement transform is wrong — bounded
  by tests that assert stamped positions per branch; a straddling run double-stamps
  (benign). jsdom returns zero rects, so the layer is inert in unit tests unless rects
  are stubbed — matching the existing `readVFlowGeometry` test pattern.

## Explicitly deferred (follow-up)
- **Full PDF/UA StructTreeRoot tagging** (headings, table/list roles, alt text on the
  Gantt as a figure). Not achievable in jsPDF client-side; requires a server-side
  tagged renderer, which reverses ADR-0159 — file as a separate ADR if PDF/UA
  conformance becomes a committed requirement.
- **Selectable text for the re-composited repeated Gantt header on vertical
  *continuation* pages** — only the first page's header is stamped; continuation
  headers remain raster-only (the visual is intact). Low value, revisit if requested.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: web
- Migration required: no
- API changes: no
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: **N/A** — fully client-side, synchronous PDF generation in
   the browser; no broker, no Celery task, no DB write.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — pure frontend; the shared helper is
   `features/export/pdfTextLayer.ts`.
5. API response on best-effort dispatch: **N/A** — no API call; the export saves a
   file directly in the browser.
6. Outbox cleanup: **N/A** — no outbox.
7. Idempotency: **N/A** — generating the PDF twice produces an equivalent document;
   no persisted side effect.
8. Dead-letter / failure handling: **N/A** — on failure the existing dialog surfaces
   the error and nothing is saved; a retry is the only recovery (unchanged).
