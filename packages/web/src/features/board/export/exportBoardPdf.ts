/**
 * Client-side board → PDF rasterizer (ADR-0159, issue 326).
 *
 * Mirrors the BurnChart export helper: dynamic-import html-to-image + jspdf so
 * neither lands in the main bundle, rasterize the off-screen `BoardPrintLayout`
 * node once, then slice the single tall bitmap into A4-landscape page bands. We
 * paginate the bitmap rather than re-rendering per page so a 200-card board
 * stays well under the 5s target — one rasterize, N cheap canvas slices.
 *
 * A selectable invisible-text layer is stamped over the raster on every page
 * (ADR-0289, issue 1687): the opt-in `data-print-text` runs from BoardPrintLayout
 * (masthead, columns, lanes, cards, footer) are re-projected to PDF points so the
 * export is searchable/selectable and screen-reader-perceivable.
 */

import {
  collectPrintTextRuns,
  setPrintDocumentMetadata,
  stampTextLayerForPage,
} from '../../export/pdfTextLayer';

/** Rasterizer sampling ratio — CSS px × this = source image px (crisp card text). */
const PIXEL_RATIO = 2;

/** Load a data-URL into an HTMLImageElement, resolving once decoded. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode board snapshot'));
    img.src = dataUrl;
  });
}

export interface ExportBoardPdfOptions {
  /** Download file name, including the `.pdf` extension. */
  fileName: string;
}

/**
 * Rasterize `node` and save a paginated A4-landscape PDF. Throws if the snapshot
 * cannot be produced (the caller surfaces a toast); nothing is persisted, so a
 * retry is the only recovery.
 */
export async function exportBoardPdf(
  node: HTMLElement,
  { fileName }: ExportBoardPdfOptions,
): Promise<void> {
  const { toPng } = await import('html-to-image');
  const { jsPDF } = await import('jspdf');

  // pixelRatio 2 keeps card text crisp in the deck; backgroundColor is left to
  // the node's own `bg-white` so the rasterizer captures a clean white page.
  const dataUrl = await toPng(node, { pixelRatio: PIXEL_RATIO });
  const img = await loadImage(dataUrl);

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // Selectable text layer (ADR-0289): collect opt-in runs once; set title/language.
  const textRuns = collectPrintTextRuns(node);
  setPrintDocumentMetadata(pdf, { title: fileName.replace(/\.pdf$/i, '') });

  // Scale the bitmap to the page width; one page covers `pageImgH` source pixels.
  const scale = pageW / img.width;
  const pageImgH = pageH / scale;

  // Single page: place the whole image (height ≤ one page) without slicing.
  if (img.height <= pageImgH + 1) {
    pdf.addImage(dataUrl, 'PNG', 0, 0, pageW, img.height * scale);
    stampTextLayerForPage(pdf, textRuns, PIXEL_RATIO, {
      srcX: 0,
      srcY: 0,
      srcW: img.width,
      srcH: img.height,
      destX: 0,
      destY: 0,
      scale,
    });
    pdf.save(fileName);
    return;
  }

  // Multi-page: slice the tall bitmap into page-height bands via an offscreen
  // canvas, one jsPDF page per band.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context (e.g. headless without canvas) — fall back to a single
    // oversized page rather than failing the export outright.
    pdf.addImage(dataUrl, 'PNG', 0, 0, pageW, img.height * scale);
    stampTextLayerForPage(pdf, textRuns, PIXEL_RATIO, {
      srcX: 0,
      srcY: 0,
      srcW: img.width,
      srcH: img.height,
      destX: 0,
      destY: 0,
      scale,
    });
    pdf.save(fileName);
    return;
  }

  let offset = 0;
  let page = 0;
  while (offset < img.height) {
    const sliceH = Math.min(pageImgH, img.height - offset);
    canvas.width = img.width;
    canvas.height = sliceH;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, offset, img.width, sliceH, 0, 0, img.width, sliceH);
    const sliceUrl = canvas.toDataURL('image/png');
    if (page > 0) pdf.addPage();
    pdf.addImage(sliceUrl, 'PNG', 0, 0, pageW, sliceH * scale);
    stampTextLayerForPage(pdf, textRuns, PIXEL_RATIO, {
      srcX: 0,
      srcY: offset,
      srcW: img.width,
      srcH: sliceH,
      destX: 0,
      destY: 0,
      scale,
    });
    offset += sliceH;
    page += 1;
  }

  pdf.save(fileName);
}

/** Build a filesystem-safe export file name: `board-<slug>-<yyyy-mm-dd>.pdf`. */
export function boardPdfFileName(projectName: string, isoDate: string): string {
  // Extract alphanumeric runs and join with '-'. Building the slug this way has
  // no leading/trailing/duplicate separators by construction, so it needs no
  // trailing-anchored trim regex (`-+$`) — the shape SonarQube S5852 flags for
  // potential super-linear backtracking.
  const slug =
    projectName
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.join('-')
      .slice(0, 40) || 'board';
  const day = isoDate.slice(0, 10);
  return `board-${slug}-${day}.pdf`;
}
