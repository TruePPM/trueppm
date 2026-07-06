/**
 * Client-side schedule → PDF rasterizer (ADR-0188, extends ADR-0159, issue 1436).
 *
 * Mirrors `exportBoardPdf`'s core — dynamic-import html-to-image + jspdf so
 * neither lands in the main bundle, rasterize the off-screen `SchedulePrintLayout`
 * node once, then slice the single tall bitmap into page bands. We paginate the
 * bitmap rather than re-rendering per page so a ~150-activity schedule stays well
 * under the generation target — one rasterize, N cheap canvas slices.
 *
 * It EXTENDS the board helper with the two schedule-specific needs ADR-0188 names:
 *   1. a cancel signal (`AbortSignal`) + determinate `onProgress` callback, for the
 *      issue 1438 generation states (cancel aborts between bands; nothing is saved); and
 *   2. horizontal banding — wide timelines exceed one landscape page *horizontally*,
 *      so the bitmap is sliced into a column × row grid. issue 1440 adds
 *      week-boundary snapping and a repeated label column: when the print surface
 *      reports its geometry (`data-print-*`), `planSheetColumns` bands the chart on
 *      whole-week seams and every sheet re-draws the frozen label strip + a "Sheet n
 *      of N" caption. The raw `bandWidthPx` seam remains for geometry-less callers.
 *      Letter AND A4.
 */

import { planSheetColumns, sheetLabel } from './scheduleSheetPlan';

export type SchedulePaper = 'letter' | 'a4';

/** Rasterizer sampling ratio — CSS px × this = source image px (crisp labels). */
const PIXEL_RATIO = 2;

export interface ExportProgress {
  /** Coarse phase label for the activity counter. */
  phase: 'rasterize' | 'paginate' | 'finalize';
  /** Bands placed so far. */
  done: number;
  /** Total bands to place (1 during rasterize). */
  total: number;
}

export interface ExportSchedulePdfOptions {
  /** Download file name, including the `.pdf` extension. */
  fileName: string;
  /** Page size; landscape is fixed. Defaults to Letter. */
  paper?: SchedulePaper;
  /** Determinate-progress callback, fed to the issue 1438 activity counter. */
  onProgress?: (progress: ExportProgress) => void;
  /** Abort signal — Cancel aborts between bands; nothing is saved when aborted. */
  signal?: AbortSignal;
  /**
   * Width of one horizontal band in source pixels. Defaults to the full bitmap
   * width (single column → vertical banding only, identical to the board). issue 1440
   * passes a week-snapped width to split wide timelines across sheets.
   */
  bandWidthPx?: number;
}

export interface ExportResult {
  fileName: string;
  pageCount: number;
  paper: SchedulePaper;
  /** Output size in bytes (best-effort; 0 when the jsPDF blob is unavailable). */
  byteSize: number;
  /** True when the export was aborted via the signal before saving. */
  canceled: boolean;
  /**
   * Object URL for the saved PDF blob, backing the issue 1438 "Open in viewer"
   * action. `null` when the blob is unavailable (jsdom/tests, or `createObjectURL`
   * unsupported) — the dialog hides "Open in viewer" in that case. The caller owns
   * the URL and MUST `URL.revokeObjectURL` it when done (the dialog revokes on close).
   */
  blobUrl: string | null;
}

/**
 * Print-surface geometry the layout stamps onto its root node (CSS px), used to
 * band a wide timeline at week boundaries with a repeated label column (issue
 * 1440). Absent (older callers, or a bare node in a unit test) → the plain
 * bitmap-band path runs instead, unchanged.
 */
interface BandGeometry {
  /** Frozen label-column strip width (CSS px), repeated on every sheet. */
  labelStripPx: number;
  /** Chart px per 7 days (CSS px), for week-boundary snapping. */
  weekPx: number;
  /** One-sheet print width (CSS px). */
  pageWidthPx: number;
  /**
   * Chart width from origin to the last bar (CSS px), excluding the scale's
   * trailing "endless scroll" buffer. Banding counts only this, so trailing
   * whitespace never spills a short schedule onto an extra sheet. 0 → unknown.
   */
  chartContentPx: number;
}

function readBandGeometry(node: HTMLElement): BandGeometry | null {
  const ds = node.dataset;
  if (!ds) return null;
  const labelStripPx = Number(ds.printLabelStripPx);
  const weekPx = Number(ds.printWeekPx);
  const pageWidthPx = Number(ds.printPageWidthPx);
  const chartContentPx = Number(ds.printChartContentPx);
  if (!Number.isFinite(labelStripPx) || labelStripPx <= 0) return null;
  if (!Number.isFinite(pageWidthPx) || pageWidthPx <= 0) return null;
  if (!Number.isFinite(weekPx) || weekPx < 0) return null;
  return {
    labelStripPx,
    weekPx,
    pageWidthPx,
    chartContentPx: Number.isFinite(chartContentPx) && chartContentPx > 0 ? chartContentPx : 0,
  };
}

/**
 * Stamp a "Sheet n of N" caption in the page's bottom-right as a REAL PDF text
 * run (selectable/searchable), so banded sheets are self-identifying even once
 * printed and shuffled. Guarded via `typeof` so the jsPDF test double — which
 * only stubs the image/save surface — is unaffected.
 */
function drawSheetCaption(pdf: unknown, caption: string, pageW: number, pageH: number): void {
  const p = pdf as {
    text?: (t: string, x: number, y: number, opts?: unknown) => void;
    setFontSize?: (n: number) => void;
    setTextColor?: (r: number, g: number, b: number) => void;
  };
  if (typeof p.text !== 'function') return;
  p.setFontSize?.(8);
  p.setTextColor?.(120, 120, 120);
  p.text(caption, pageW - 6, pageH - 6, { align: 'right' });
}

/** Load a data-URL into an HTMLImageElement, resolving once decoded. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode schedule snapshot'));
    img.src = dataUrl;
  });
}

function canceledResult(fileName: string, paper: SchedulePaper): ExportResult {
  return { fileName, pageCount: 0, paper, byteSize: 0, canceled: true, blobUrl: null };
}

/**
 * Save the PDF and, best-effort, materialize its blob ONCE to derive both the
 * output size and the "Open in viewer" object URL (issue 1438). The blob call is
 * absent in jsdom/mock and `createObjectURL` is unimplemented there, so both are
 * guarded — `byteSize` falls back to 0 and `blobUrl` to null, and the download
 * still fires via `pdf.save` (mock-friendly, unchanged from the issue-1437 path).
 */
function finalizePdf(
  pdf: { output: (type: string) => unknown; save: (name: string) => void },
  fileName: string,
): { byteSize: number; blobUrl: string | null } {
  let byteSize = 0;
  let blobUrl: string | null = null;
  try {
    const blob = pdf.output('blob') as Blob & { size?: number };
    if (blob && typeof blob.size === 'number') byteSize = blob.size;
    if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      blobUrl = URL.createObjectURL(blob);
    }
  } catch {
    /* jsdom / mock: no real blob or no createObjectURL — leave defaults. */
  }
  pdf.save(fileName);
  return { byteSize, blobUrl };
}

/**
 * Rasterize `node` and save a paginated landscape PDF, reporting progress and
 * honoring cancellation. Throws if the snapshot cannot be produced (the issue 1438
 * dialog surfaces the machine code); nothing is persisted, so a retry is the only
 * recovery.
 */
export async function exportSchedulePdf(
  node: HTMLElement,
  { fileName, paper = 'letter', onProgress, signal, bandWidthPx }: ExportSchedulePdfOptions,
): Promise<ExportResult> {
  if (signal?.aborted) return canceledResult(fileName, paper);

  const { toPng } = await import('html-to-image');
  const { jsPDF } = await import('jspdf');

  onProgress?.({ phase: 'rasterize', done: 0, total: 1 });
  // pixelRatio 2 keeps row labels and the date scale crisp; backgroundColor is
  // left to the node's own `bg-white` so the rasterizer captures a clean page.
  const dataUrl = await toPng(node, { pixelRatio: PIXEL_RATIO });
  if (signal?.aborted) return canceledResult(fileName, paper);
  const img = await loadImage(dataUrl);
  if (signal?.aborted) return canceledResult(fileName, paper);

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: paper });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // ── Week-snapped horizontal banding with a repeated label column (issue 1440) ──
  // When the print surface reports its geometry and the timeline is wider than one
  // sheet, band the bitmap on week boundaries: each sheet re-draws the frozen label
  // strip (source x 0..labelStripImg) then its own chart slice, and carries a
  // "Sheet n of N" caption. A single fixed scale keeps bars the same size on every
  // sheet so they read across the seams. Falls through to the plain bitmap-band
  // path below when geometry is absent or the timeline fits one sheet wide.
  const geom = readBandGeometry(node);
  if (geom) {
    const labelStripImg = Math.min(geom.labelStripPx * PIXEL_RATIO, img.width);
    // Band only the content region (label strip + chart up to the last bar), so
    // the scale's trailing buffer whitespace never counts toward the sheet count.
    const contentWidthImg = geom.chartContentPx
      ? Math.min(img.width, labelStripImg + geom.chartContentPx * PIXEL_RATIO)
      : img.width;
    const plan = planSheetColumns({
      imageWidthPx: contentWidthImg,
      chartLeftPx: labelStripImg,
      pageWidthPx: geom.pageWidthPx * PIXEL_RATIO,
      weekPx: geom.weekPx * PIXEL_RATIO,
    });
    const bandCanvas = document.createElement('canvas');
    const bandCtx = bandCanvas.getContext('2d');
    if (plan.columns.length > 1 && bandCtx) {
      const sheetSrcW = labelStripImg + plan.bandWidthPx;
      const scale = pageW / sheetSrcW;
      const pageImgH = pageH / scale;
      const rowBands = Math.max(1, Math.ceil(img.height / (pageImgH + 1)));
      const total = plan.columns.length * rowBands;

      let placed = 0;
      for (const column of plan.columns) {
        for (let r = 0; r < rowBands; r++) {
          // Cancel between sheets: stop without saving, so nothing reaches disk.
          if (signal?.aborted) return canceledResult(fileName, paper);

          const sy = r * pageImgH;
          const sliceH = Math.min(pageImgH, img.height - sy);
          bandCanvas.width = labelStripImg + column.sliceW;
          bandCanvas.height = sliceH;
          bandCtx.clearRect(0, 0, bandCanvas.width, bandCanvas.height);
          // Frozen label strip, repeated on every sheet so activity rows line up.
          bandCtx.drawImage(img, 0, sy, labelStripImg, sliceH, 0, 0, labelStripImg, sliceH);
          // This sheet's chart band, drawn to the right of the label strip.
          bandCtx.drawImage(
            img,
            column.chartSx,
            sy,
            column.sliceW,
            sliceH,
            labelStripImg,
            0,
            column.sliceW,
            sliceH,
          );
          const sheetUrl = bandCanvas.toDataURL('image/png');
          if (placed > 0) pdf.addPage();
          pdf.addImage(
            sheetUrl,
            'PNG',
            0,
            0,
            (labelStripImg + column.sliceW) * scale,
            sliceH * scale,
          );
          placed += 1;
          drawSheetCaption(pdf, sheetLabel(placed, total), pageW, pageH);
          onProgress?.({ phase: 'paginate', done: placed, total });
        }
      }

      if (signal?.aborted) return canceledResult(fileName, paper);
      onProgress?.({ phase: 'finalize', done: total, total });
      const { byteSize, blobUrl } = finalizePdf(pdf, fileName);
      return { fileName, pageCount: placed, paper, byteSize, canceled: false, blobUrl };
    }
  }

  // One horizontal band is `columnWidth` source px wide, scaled to the page
  // width. Default (full width) → a single column, so this degenerates to the
  // board's fit-to-width vertical banding.
  const columnWidth = Math.min(bandWidthPx ?? img.width, img.width);
  const scale = pageW / columnWidth;
  const pageImgH = pageH / scale;

  const cols = Math.max(1, Math.ceil(img.width / columnWidth));
  const rows = Math.max(1, Math.ceil(img.height / (pageImgH + 1)));
  const total = cols * rows;

  // Fast path: the whole bitmap fits one page (single column, single row).
  if (total === 1) {
    onProgress?.({ phase: 'paginate', done: 0, total: 1 });
    pdf.addImage(dataUrl, 'PNG', 0, 0, columnWidth * scale, img.height * scale);
    onProgress?.({ phase: 'finalize', done: 1, total: 1 });
    const { byteSize, blobUrl } = finalizePdf(pdf, fileName);
    return { fileName, pageCount: 1, paper, byteSize, canceled: false, blobUrl };
  }

  // Multi-band: slice the bitmap into a col × row grid via an offscreen canvas.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context (headless without canvas) — fall back to a single oversized
    // page rather than failing the export outright (mirrors the board helper).
    pdf.addImage(dataUrl, 'PNG', 0, 0, pageW, img.height * scale);
    onProgress?.({ phase: 'finalize', done: 1, total: 1 });
    const { byteSize, blobUrl } = finalizePdf(pdf, fileName);
    return { fileName, pageCount: 1, paper, byteSize, canceled: false, blobUrl };
  }

  let placed = 0;
  for (let col = 0; col < cols; col++) {
    const sx = col * columnWidth;
    const sliceW = Math.min(columnWidth, img.width - sx);
    for (let row = 0; row < rows; row++) {
      // Cancel between bands: stop without saving, so nothing reaches disk.
      if (signal?.aborted) return canceledResult(fileName, paper);

      const sy = row * pageImgH;
      const sliceH = Math.min(pageImgH, img.height - sy);
      canvas.width = sliceW;
      canvas.height = sliceH;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, sliceW, sliceH, 0, 0, sliceW, sliceH);
      const sliceUrl = canvas.toDataURL('image/png');
      if (placed > 0) pdf.addPage();
      pdf.addImage(sliceUrl, 'PNG', 0, 0, sliceW * scale, sliceH * scale);
      placed += 1;
      onProgress?.({ phase: 'paginate', done: placed, total });
    }
  }

  if (signal?.aborted) return canceledResult(fileName, paper);
  onProgress?.({ phase: 'finalize', done: total, total });
  const { byteSize, blobUrl } = finalizePdf(pdf, fileName);
  return { fileName, pageCount: placed, paper, byteSize, canceled: false, blobUrl };
}

/**
 * Build the export file name: `<Project>_Schedule_<yyyy-mm-dd>.pdf`. Non-alphanumeric
 * runs in the project name collapse to `_`; an unslug-able name falls back to
 * `Project` (so the default reads `Project_Schedule_<date>.pdf`).
 */
export function scheduledPdfFileName(projectName: string, isoDate: string): string {
  const slug =
    projectName
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'Project';
  const day = isoDate.slice(0, 10);
  return `${slug}_Schedule_${day}.pdf`;
}
