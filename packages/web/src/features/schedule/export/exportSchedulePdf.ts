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
 *      so the bitmap is sliced into a column × row grid. The foundation exposes the
 *      seam via `bandWidthPx`; issue 1440 owns week-boundary snapping. Letter AND A4.
 */

export type SchedulePaper = 'letter' | 'a4';

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
  return { fileName, pageCount: 0, paper, byteSize: 0, canceled: true };
}

/** Best-effort byte size of the rendered PDF (the mock has no `output`). */
function pdfByteSize(pdf: { output: (type: string) => unknown }): number {
  try {
    const blob = pdf.output('blob') as { size?: number };
    if (blob && typeof blob.size === 'number') return blob.size;
  } catch {
    /* jsdom / mock: no real blob — fall through. */
  }
  return 0;
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
  const dataUrl = await toPng(node, { pixelRatio: 2 });
  if (signal?.aborted) return canceledResult(fileName, paper);
  const img = await loadImage(dataUrl);
  if (signal?.aborted) return canceledResult(fileName, paper);

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: paper });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

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
    pdf.save(fileName);
    return { fileName, pageCount: 1, paper, byteSize: pdfByteSize(pdf), canceled: false };
  }

  // Multi-band: slice the bitmap into a col × row grid via an offscreen canvas.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context (headless without canvas) — fall back to a single oversized
    // page rather than failing the export outright (mirrors the board helper).
    pdf.addImage(dataUrl, 'PNG', 0, 0, pageW, img.height * scale);
    onProgress?.({ phase: 'finalize', done: 1, total: 1 });
    pdf.save(fileName);
    return { fileName, pageCount: 1, paper, byteSize: pdfByteSize(pdf), canceled: false };
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
  pdf.save(fileName);
  return { fileName, pageCount: placed, paper, byteSize: pdfByteSize(pdf), canceled: false };
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
