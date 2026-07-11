/**
 * Pure vertical-page planning for a tall schedule PDF report (ADR-0276, issue 1694).
 *
 * The single-column ("fits one page wide") Layout-A report is taller than one
 * landscape page for any non-trivial schedule. Rather than slice the rasterized
 * bitmap at a fixed pixel height — which cuts through Gantt rows, the critical-path
 * chain, and the footer — this planner computes page breaks that fall only on SAFE
 * boundaries (between whole rows, before the CP card, before the footer) and marks
 * which repeated header each continuation page needs so it reads standalone:
 *   - a Gantt continuation repeats the frozen Activity + date-scale header band
 *     (re-composited from the source bitmap, so bars still align to their dates);
 *   - a CP-chain continuation gets a "Critical Path Chain (Continued)" running
 *     header (drawn by the rasterizer as real PDF text — no bitmap band).
 *
 * React-free and unit-tested (`scheduleVerticalPlan.test.ts`); `exportSchedulePdf`
 * consumes the plan. All measurements are in **source image pixels** (the
 * rasterizer's coordinate space), never CSS px — the caller multiplies the
 * layout's measured CSS geometry by the pixel ratio before planning.
 */

/** The Gantt header band that repeats atop a Gantt continuation page. */
export interface GanttHeaderBand {
  /** Source-y (img px) of the repeatable band (label-col header + date scale). */
  top: number;
  /** Band height (img px) — the fixed HEADER_H strip. */
  height: number;
}

/** The Gantt rows region — page breaks may fall on any row boundary within it. */
export interface GanttRowsRegion {
  top: number;
  bottom: number;
  /** One row's height (img px); breaks land at `top + k·rowH`. */
  rowH: number;
}

/**
 * The critical-path-chain block. `headerTop` is where the bordered card begins (a
 * safe break — the whole card can start a fresh page); `rowsTop..rowsBottom` is the
 * flowing 2-column list whose grid-row boundaries are safe breaks.
 */
export interface CpBlock {
  headerTop: number;
  rowsTop: number;
  rowsBottom: number;
  /** One grid-row's height (img px). */
  rowH: number;
}

/**
 * The "Unscheduled — Planned Work" block (#1799) — a keep-together card between
 * the CP summary and the footer. It is never split: `top`..`bottom` are safe
 * break boundaries so a page break can fall *before* or *after* it, but the
 * planner adds no interior breaks, so the whole block starts on a fresh page
 * when it doesn't fit the remaining space (ADR-0276, mirroring the footer's
 * keep-together treatment).
 */
export interface UnscheduledBlock {
  top: number;
  bottom: number;
}

export interface VerticalFlowGeometry {
  /** Full rasterized bitmap height (img px). */
  imageHeightPx: number;
  ganttHeader: GanttHeaderBand;
  ganttRows: GanttRowsRegion;
  /** Null when the CP summary is omitted or empty. */
  cp: CpBlock | null;
  /** Null/absent when there is no planned-but-unscheduled work (#1799). */
  unscheduled?: UnscheduledBlock | null;
  /** Sign-off + watermark strip — kept together, never split. */
  footerTop: number;
}

/** The repeated header re-composited atop a continuation page (or null for page 1). */
export type PageHeader =
  /** Gantt header band lifted from the source bitmap at `bandSy..bandSy+height`. */
  | { kind: 'gantt'; height: number; bandSy: number }
  /** CP "(Continued)" running header — the rasterizer draws real PDF text; no band. */
  | { kind: 'cp'; height: number };

/** One placed page: a body slice from the source bitmap + an optional repeated header. */
export interface VerticalPage {
  /** Source-y (img px) where this page's body slice begins. */
  sy: number;
  /** Body slice height (img px). */
  sh: number;
  /** Repeated header composited above the body slice, or null on the first page. */
  header: PageHeader | null;
}

/**
 * Height reserved for the CP "(Continued)" running header, in the planner's **source
 * image px** (the same space as every other geometry value here — already ×
 * PIXEL_RATIO). The rasterizer draws the header text into this blank band; the height
 * carries clear space above and below the text so it never crowds the first continued
 * row. ~52 img px ≈ 26 CSS px ≈ a comfortable single running-header line.
 */
export const CP_CONTINUED_HEADER_PX = 52;

/**
 * Never strand fewer than this many Gantt rows alone on a continuation page (issue
 * 1686). When filling a page maximally would leave a tiny remainder of Gantt rows,
 * the planner backs the break off to an earlier row boundary so the next page keeps
 * at least this many — a widow/orphan control, not a rescale (the fixed print scale
 * is deliberate; bars stay the same size on every page).
 */
export const MIN_GANTT_ORPHAN_ROWS = 3;

/**
 * Back a chosen break off to avoid stranding `< minRows` Gantt rows on the next page.
 *
 * Only acts when `next` lands strictly inside the Gantt rows region (so more rows
 * follow). If the remainder below `next` is a small orphan, it pulls the break to the
 * largest earlier row boundary that still lies past the cursor, so the continuation
 * page keeps `>= minRows`. Best-effort: if no earlier boundary exists, the original
 * break stands (accept the orphan rather than loop).
 */
function avoidGanttOrphan(
  next: number,
  cursor: number,
  breaks: number[],
  geom: VerticalFlowGeometry,
  minRows: number,
): number {
  const { ganttRows } = geom;
  if (!(next > ganttRows.top && next < ganttRows.bottom)) return next;
  const rowsLeft = Math.round((ganttRows.bottom - next) / ganttRows.rowH);
  if (rowsLeft <= 0 || rowsLeft >= minRows) return next;
  const target = next - (minRows - rowsLeft) * ganttRows.rowH;
  const candidates = breaks.filter((b) => b > cursor && b <= target);
  return candidates.length > 0 ? candidates[candidates.length - 1] : next;
}

/** Sorted-ascending unique numbers, dropping values outside `(0, imageHeight]`. */
function safeBreaks(geom: VerticalFlowGeometry): number[] {
  const { imageHeightPx, ganttRows, cp, unscheduled, footerTop } = geom;
  const set = new Set<number>();
  // Every Gantt row boundary (top+rowH … bottom) is a safe cut.
  for (let y = ganttRows.top + ganttRows.rowH; y < ganttRows.bottom; y += ganttRows.rowH) {
    set.add(Math.round(y));
  }
  set.add(Math.round(ganttRows.bottom)); // end of the Gantt block
  if (cp) {
    set.add(Math.round(cp.headerTop)); // before the CP card (start it on a fresh page)
    for (let y = cp.rowsTop + cp.rowH; y < cp.rowsBottom; y += cp.rowH) {
      set.add(Math.round(y));
    }
    set.add(Math.round(cp.rowsBottom));
  }
  if (unscheduled) {
    // Keep-together (#1799): only the block's outer edges are safe cuts, so a page
    // break falls before or after the whole block, never inside it.
    set.add(Math.round(unscheduled.top));
    set.add(Math.round(unscheduled.bottom));
  }
  set.add(Math.round(footerTop)); // keep the sign-off footer together
  set.add(Math.round(imageHeightPx)); // the report end
  return [...set].filter((y) => y > 0 && y <= Math.round(imageHeightPx)).sort((a, b) => a - b);
}

/**
 * The repeated header a continuation page needs, given where its body begins.
 *
 * A page whose body starts inside the Gantt rows repeats the Gantt header band; one
 * that starts inside the CP list repeats the CP "(Continued)" running header; one
 * that starts on the CP card top (the header is in the body slice) or in the
 * legend/footer gap needs no repeat.
 */
function headerForCursor(cursor: number, geom: VerticalFlowGeometry): PageHeader | null {
  const { ganttHeader, ganttRows, cp } = geom;
  if (cursor >= ganttRows.top && cursor < ganttRows.bottom) {
    return { kind: 'gantt', height: ganttHeader.height, bandSy: ganttHeader.top };
  }
  if (cp && cursor >= cp.rowsTop && cursor < cp.rowsBottom) {
    return { kind: 'cp', height: CP_CONTINUED_HEADER_PX };
  }
  return null;
}

/**
 * Plan the vertical pages for the single-column report.
 *
 * Greedy over the safe-break list: each page takes the largest safe break that
 * fits the available body height (page height minus any repeated header), so a page
 * is filled as much as possible without ever cutting a row. Returns a single
 * full-height page when the whole report fits one page.
 *
 * @param geom Measured flow geometry in source image px.
 * @param pageBodyPx Usable page height in source image px (page height ÷ fit scale).
 */
export function planVerticalPages(
  geom: VerticalFlowGeometry,
  pageBodyPx: number,
): VerticalPage[] {
  const end = Math.round(geom.imageHeightPx);
  let breaks = safeBreaks(geom);
  const pages: VerticalPage[] = [];

  let cursor = 0;
  // Guard against a pathological zero/negative page budget (degenerate geometry).
  const bodyBudget = Math.max(1, pageBodyPx);

  // Keep the critical-path card whole when it fits one page: drop the interior CP-list
  // break candidates so the greedy planner can only start the whole card on a fresh
  // page or push it there entirely — never split it and leave 1-2 CP rows alone on the
  // next page (the user's "page 2 had only 2 CP rows" report, issue 1686). Its outer
  // boundaries (`headerTop`, `rowsBottom`) stay so the card can still start a page.
  const cp = geom.cp;
  if (cp && cp.rowsBottom - cp.headerTop <= bodyBudget) {
    breaks = breaks.filter((b) => !(b > cp.headerTop && b < cp.rowsBottom));
  }

  while (cursor < end) {
    const header = cursor === 0 ? null : headerForCursor(cursor, geom);
    const avail = Math.max(1, bodyBudget - (header?.height ?? 0));
    const limit = cursor + avail;

    // Largest safe break that fits the available body; else the smallest break past
    // the cursor (a single unit taller than a page — impossible at row heights, but
    // never loop forever); else the report end.
    const fitting = breaks.filter((b) => b > cursor && b <= limit);
    const chosen =
      fitting.length > 0
        ? fitting[fitting.length - 1]
        : (breaks.find((b) => b > cursor) ?? end);
    // Widow/orphan guard: don't strand a tiny remainder of Gantt rows on the next page.
    const next = avoidGanttOrphan(chosen, cursor, breaks, geom, MIN_GANTT_ORPHAN_ROWS);

    pages.push({ sy: cursor, sh: next - cursor, header });
    cursor = next;
  }

  // A report with no dated content (no breaks, end reached immediately) still needs
  // one page so the masthead/KPI cover is emitted.
  if (pages.length === 0) pages.push({ sy: 0, sh: end, header: null });
  return pages;
}

/** "Page n of N" caption for a placed vertical page (1-based). */
export function pageLabel(placed: number, total: number): string {
  return `Page ${placed} of ${total}`;
}
