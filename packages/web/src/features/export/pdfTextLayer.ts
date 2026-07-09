/**
 * Selectable invisible-text layer for the client-side PDF exports (ADR-0289, issue
 * 1687).
 *
 * The schedule/board exports rasterize an off-screen print surface to a PNG and embed
 * it with jsPDF `addImage` — a flat image with no selectable text or reading order
 * (ADR-0159/0188). This module adds a *real* selectable text layer on top of that
 * raster, the classic OCR/scanned-PDF pattern: every content node the print layout
 * opts into with `data-print-text="<role>"` contributes one jsPDF text run drawn in
 * rendering mode 3 ("invisible") over the pixels that already show it — so the text is
 * searchable/selectable and read by assistive tech, but never double-prints.
 *
 * Geometry is *measured* (`getBoundingClientRect`), not computed from layout
 * constants, so the same collector serves the schedule's fixed-pitch rows and the
 * board's variable-height cards. Runs are returned in DOM document order, which the
 * layouts arrange as the logical reading order (masthead → KPIs → rows → critical-path
 * chain → footer); stamping them in that order gives the PDF content stream a logical
 * text order (jsPDF cannot emit a PDF/UA structure tree — see ADR-0289).
 */

/** One selectable text run: its text and its box relative to the print root (CSS px). */
export interface PrintTextRun {
  /** Collapsed, trimmed text content of the marked element. */
  text: string;
  /** Left edge relative to the print-surface root, in CSS px. */
  left: number;
  /** Top edge relative to the print-surface root, in CSS px. */
  top: number;
  /** Box width in CSS px. */
  width: number;
  /** Box height in CSS px. */
  height: number;
  /** The `data-print-text` role, for reading-order grouping / future tagging. */
  role: string;
}

/**
 * Collect opt-in selectable text runs from a rendered print surface, in DOM document
 * (= logical reading) order. Each `[data-print-text]` element contributes one run with
 * its trimmed text and its bounding box relative to `root` (CSS px). Elements with
 * empty text or a degenerate zero-area rect — e.g. jsdom without layout, or an
 * off-screen surface that was never measured — are skipped, so a caller without layout
 * gets an empty layer and the raster still exports unchanged.
 */
export function collectPrintTextRuns(root: HTMLElement): PrintTextRun[] {
  const rootRect = root.getBoundingClientRect();
  const runs: PrintTextRun[] = [];
  root.querySelectorAll<HTMLElement>('[data-print-text]').forEach((el) => {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    runs.push({
      text,
      left: r.left - rootRect.left,
      top: r.top - rootRect.top,
      width: r.width,
      height: r.height,
      role: el.dataset.printText ?? '',
    });
  });
  return runs;
}

/**
 * Placement of one page's raster slice: the source region of the full bitmap shown on
 * this page (image px) mapped to a PDF-point origin at a fixed scale.
 */
export interface PageTextPlacement {
  /** Left edge of the shown source region, in image px. */
  srcX: number;
  /** Top edge of the shown source region, in image px. */
  srcY: number;
  /** Width of the shown source region, in image px. */
  srcW: number;
  /** Height of the shown source region, in image px. */
  srcH: number;
  /** PDF-point X where `srcX` lands on the page. */
  destX: number;
  /** PDF-point Y where `srcY` lands on the page. */
  destY: number;
  /** PDF points per image px (the same scale used for `addImage`). */
  scale: number;
}

/** The subset of the jsPDF surface the text layer touches (all optional → guarded). */
interface PdfTextSurface {
  text?: (t: string, x: number, y: number, opts?: unknown) => void;
  setFontSize?: (n: number) => void;
  setTextColor?: (r: number, g: number, b: number) => void;
  setProperties?: (props: Record<string, unknown>) => void;
  setLanguage?: (lang: string) => void;
}

/**
 * Stamp the intersecting selectable text runs onto one placed page. `runs` are in CSS
 * px relative to the print root; `ratio` is the rasterizer's pixel ratio (CSS px ×
 * ratio = image px), so a run's image-px box is compared against the page's source
 * region and re-projected to PDF points. Text is drawn invisible (rendering mode 3):
 * selectable and searchable, but the raster provides the visible glyphs so nothing
 * double-prints. `typeof`-guarded so the jsPDF test double (which need not stub
 * `.text`) is unaffected.
 */
export function stampTextLayerForPage(
  pdf: unknown,
  runs: readonly PrintTextRun[],
  ratio: number,
  place: PageTextPlacement,
): void {
  const p = pdf as PdfTextSurface;
  if (typeof p.text !== 'function') return;
  const srcRight = place.srcX + place.srcW;
  const srcBottom = place.srcY + place.srcH;
  // Report-ink navy so if a viewer ever renders mode-3 text it reads as body ink;
  // it is invisible in a conformant renderer regardless (rgb, not a scanned hex).
  p.setTextColor?.(27, 42, 74);
  for (const run of runs) {
    const ix = run.left * ratio;
    const iy = run.top * ratio;
    const iw = run.width * ratio;
    const ih = run.height * ratio;
    // Skip runs that do not intersect this page's shown source region.
    if (iy + ih <= place.srcY || iy >= srcBottom) continue;
    if (ix + iw <= place.srcX || ix >= srcRight) continue;
    const xPt = place.destX + (ix - place.srcX) * place.scale;
    const yPt = place.destY + (iy - place.srcY) * place.scale;
    const boxPt = ih * place.scale;
    // Fit the font to the box height (bounded), so caret/selection tracks the glyphs.
    const size = Math.max(4, Math.min(18, boxPt * 0.8));
    p.setFontSize?.(size);
    p.text(run.text, xPt, yPt, { renderingMode: 'invisible', baseline: 'top' });
  }
}

/**
 * Set the exported document's `/Title` and `/Lang` (ADR-0289). `/Lang` (`en-US`) is
 * the one PDF/UA-relevant property jsPDF can emit and is what lets assistive tech pick
 * the right pronunciation. Both calls are `typeof`-guarded for the test double.
 */
export function setPrintDocumentMetadata(pdf: unknown, opts: { title: string }): void {
  const p = pdf as PdfTextSurface;
  p.setLanguage?.('en-US');
  p.setProperties?.({ title: opts.title, creator: 'TruePPM' });
}
