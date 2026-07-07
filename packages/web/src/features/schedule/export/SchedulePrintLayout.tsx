/**
 * Off-screen static print surface for the schedule PDF export (ADR-0188, issue 1436).
 *
 * The sibling of `BoardPrintLayout`, with two additions ADR-0188 requires: it
 * re-projects the canvas Gantt as **static DOM + an `<svg>` dependency-arrow
 * overlay**, and it owns its OWN `GanttScaleData` (full project span, a
 * print-width `pxPerDay`, `scrollLeft = 0`) built via the engine's shared
 * geometry layer. It never captures the live dark canvas — it redraws the full
 * timeline in the LIGHT theme at a fixed print width, so the artifact is correct
 * on extent, theme, and scale simultaneously, and labels stay crisp under the 2×
 * rasterization (the exported PDF embeds this surface as a high-resolution image;
 * it is NOT a tagged/selectable-text PDF — a tagged pipeline is tracked in #1687).
 *
 * The LIGHT theme is enforced, not assumed: the root carries the `.theme-light`
 * token island (issue #1683) so the export stays legible even when the app is in
 * dark mode. Without it, the DS tokens below resolve to their dark values on the
 * fixed-white sheet and the rasterizer captures light ink on a white page.
 *
 * Styling uses Design-System tokens only (no raw hex, no shadow utilities) via
 * the `schedulePrintTheme` role→token map, so html-to-image captures the theme's
 * resolved light colors and the design-system-v2 gate stays green. Owners render
 * as initials, never remote avatar images.
 *
 * On the issue-1436 geometry/theme/overlay foundation, this surface composes the
 * full **Layout A** one-page Gantt (issue 1437): the export-provenance masthead, the
 * 5-cell KPI strip, the full-timeline Gantt with FS dependency arrows, the
 * critical-path summary box (the ordered driving chain), and the sign-off +
 * content-fingerprint stamp. The 3-page Layout B is issue 1439; week-boundary banding
 * + dense-arrow routing is issue 1440.
 */
import { forwardRef, useMemo } from 'react';
import {
  buildScaleDataFromPxPerDay,
  clampPxPerDay,
  dateToLeft,
  dateToRight,
  type GanttScaleData,
} from '../engine';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { scheduleExportFooterWatermark } from './scheduleExportEdition';
import {
  barFillClass,
  milestoneFillClass,
  arrowColorVar,
  roleBgClass,
} from './schedulePrintTheme';
import {
  barBox,
  barExtent,
  fsConnectorPath,
  channelOffsetPx,
  MILESTONE_HALF_PX,
} from './scheduleArrowGeometry';
import {
  labelIndentPx,
  orderLinksForPaint,
  type SchedulePrintData,
  type SchedulePrintRow,
} from './schedulePrintData';
import type { SchedulePaper } from './exportSchedulePdf';

/** Fixed print width per paper at 96 dpi, landscape — a stable rasterizer canvas. */
const PRINT_WIDTH_PX: Record<SchedulePaper, number> = {
  letter: 1056, // 11in × 96
  a4: 1123, // 297mm × 96
};

const LABEL_COL_PX = 280;
const SHEET_PAD_PX = 24;
const ROW_H = 22;
const HEADER_H = 36;
const BAR_H = 12;
const MS_PER_DAY = 86_400_000;

/**
 * Legibility floor for the print scale (issue 1440). Rather than compress an
 * arbitrarily long timeline onto one page — which shrinks a week to a few px and
 * collapses short bars into indistinguishable slivers — the scale holds this
 * minimum density and the export bands the over-wide surface across sheets. At
 * ≈ 2 px/day a week stays ~14 px wide (readable), and a timeline longer than
 * roughly a year spills onto a second sheet instead of becoming illegible.
 */
const MIN_PRINT_PX_PER_DAY = 2;

/** Min/max ISO date across dated rows, or null when none are dated. */
function projectSpan(rows: SchedulePrintRow[]): { start: string; finish: string } | null {
  const starts = rows.filter((r) => r.start).map((r) => r.start as string);
  const finishes = rows.filter((r) => r.finish).map((r) => r.finish as string);
  if (starts.length === 0 || finishes.length === 0) return null;
  return { start: starts.slice().sort()[0], finish: finishes.slice().sort().at(-1) as string };
}

/**
 * Choose a `pxPerDay` that fits the timeline into the print chart width, then
 * refine once to absorb the scale builder's zoom-dependent padding. The chart
 * container then uses the resulting `totalWidth` so bars never clip. A timeline
 * that would compress below {@link MIN_PRINT_PX_PER_DAY} instead holds that
 * density and overflows the page — the export bands it across sheets at a
 * readable scale (issue 1440), rather than squeezing it into one illegible page.
 */
function buildPrintScale(startIso: string, finishIso: string, chartW: number): GanttScaleData {
  const rawSpanDays = Math.max(
    1,
    (new Date(`${finishIso}T00:00:00Z`).getTime() - new Date(`${startIso}T00:00:00Z`).getTime()) /
      MS_PER_DAY,
  );
  let pxPerDay = clampPxPerDay(chartW / rawSpanDays);
  let scales = buildScaleDataFromPxPerDay(pxPerDay, startIso, finishIso);
  if (scales.totalWidth > 0) {
    pxPerDay = clampPxPerDay(pxPerDay * (chartW / scales.totalWidth));
    scales = buildScaleDataFromPxPerDay(pxPerDay, startIso, finishIso);
  }
  if (pxPerDay < MIN_PRINT_PX_PER_DAY) {
    pxPerDay = clampPxPerDay(MIN_PRINT_PX_PER_DAY);
    scales = buildScaleDataFromPxPerDay(pxPerDay, startIso, finishIso);
  }
  return scales;
}

/** Week-boundary gridline X positions across the scale (every 7 days from start). */
function weekGridlines(scales: GanttScaleData): number[] {
  const xs: number[] = [];
  const startMs = scales.start.getTime();
  const endMs = scales.end.getTime();
  for (let ms = startMs; ms <= endMs; ms += 7 * MS_PER_DAY) {
    xs.push(dateToLeft(new Date(ms).toISOString(), scales));
  }
  return xs;
}

/** First-of-month labels for the scale header. */
function monthLabels(scales: GanttScaleData): { x: number; label: string }[] {
  const out: { x: number; label: string }[] = [];
  const d = new Date(Date.UTC(scales.start.getUTCFullYear(), scales.start.getUTCMonth(), 1));
  while (d.getTime() <= scales.end.getTime()) {
    if (d.getTime() >= scales.start.getTime()) {
      out.push({ x: dateToLeft(d.toISOString(), scales), label: fmtUtcShort(d.toISOString()) });
    }
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

interface SchedulePrintLayoutProps {
  data: SchedulePrintData;
  paper?: SchedulePaper;
  /** Optional ISO data-date ("now" line); drawn only when within the span. */
  dataDate?: string;
  /** issue 1438 "Include" toggles. Default on, so the issue-1437 call is unchanged. */
  includeArrows?: boolean;
  includeOwnerColumn?: boolean;
  includeCpSummary?: boolean;
}

/**
 * Off-screen print surface. The parent positions this node out of view; we own
 * only its visual structure. `forwardRef` so `exportSchedulePdf` can hand the
 * node to html-to-image.
 */
export const SchedulePrintLayout = forwardRef<HTMLDivElement, SchedulePrintLayoutProps>(
  function SchedulePrintLayout(
    {
      data,
      paper = 'letter',
      dataDate,
      includeArrows = true,
      includeOwnerColumn = true,
      includeCpSummary = true,
    },
    ref,
  ) {
    const watermark = scheduleExportFooterWatermark();
    const { rows, links, kpis, cpChain, masthead, footer } = data;

    const printWidth = PRINT_WIDTH_PX[paper];
    // Hiding the owner column narrows the label gutter and yields the width to the
    // chart, so bars stay legible when owners are dropped (issue 1438).
    const labelColPx = includeOwnerColumn ? LABEL_COL_PX : LABEL_COL_PX - 40;
    const chartTargetW = printWidth - labelColPx - SHEET_PAD_PX * 2;

    const layout = useMemo(() => {
      const span = projectSpan(rows);
      if (!span) return null;
      const scales = buildPrintScale(span.start, span.finish, chartTargetW);
      const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
      // Content width = chart origin → the last bar's right edge (+ a small
      // margin), NOT scales.totalWidth. The scale pads a 28-day "endless scroll"
      // buffer past the finish that the export must NOT count as chart when
      // deciding how many sheets a wide timeline needs — otherwise the buffer
      // whitespace alone would spill a short schedule onto a near-empty 2nd sheet.
      const contentW = Math.min(scales.totalWidth, dateToRight(span.finish, scales) + SHEET_PAD_PX);
      return { scales, rowIndex, chartW: scales.totalWidth, contentW };
    }, [rows, chartTargetW]);

    const sheetWidth = layout ? labelColPx + layout.chartW + SHEET_PAD_PX * 2 : printWidth;
    const rowsAreaH = rows.length * ROW_H;

    // Geometry the rasterizer reads off the node to band a wide timeline on week
    // boundaries with a repeated label column (issue 1440). The label strip is the
    // sheet's left pad (p-6 === SHEET_PAD_PX) + the label column + its two 1px
    // borders; `printWidth` is one sheet's width; the week pitch is 7 · pxPerDay.
    const labelStripPx = SHEET_PAD_PX + labelColPx + 2;
    // The scale carries px-per-millisecond (not px-per-day), so derive the week
    // pitch from it; this is the same geometry the week gridlines step by.
    const weekPx = layout ? layout.scales.pxPerMs * 7 * MS_PER_DAY : null;

    // Order links so soft draw under hard, and give each arrow leaving a shared
    // source its own staggered vertical channel so a dense fan doesn't collapse
    // into one line (issue 1440). `seq` is derived from the stable source order,
    // independent of the paint order, so a re-render keeps the same channels.
    const paintLinks = orderLinksForPaint(links);
    // Charcoal arrow ink as an inline-`style` CSS-var value. Applied via `style`, not
    // a Tailwind class: html-to-image drops CSS-class `stroke` on SVG `<path>` when it
    // rasterizes, so a class-based connector renders as 0 ink while its arrowhead
    // (class `fill`) survives — the "arrowheads but no lines" bug (issue 1694).
    const arrowColor = arrowColorVar();
    const channelSeqByLink = new Map<string, number>();
    const perSourceCount = new Map<string, number>();
    for (const l of links) {
      const n = perSourceCount.get(l.fromId) ?? 0;
      channelSeqByLink.set(l.id, n);
      perSourceCount.set(l.fromId, n + 1);
    }

    const dataDateX =
      layout && dataDate
        ? (() => {
            const x = dateToLeft(dataDate, layout.scales);
            return x >= 0 && x <= layout.chartW ? x : null;
          })()
        : null;

    const kpiCells = [
      kpis.window,
      kpis.criticalPath,
      kpis.forecastP80,
      kpis.progress,
      kpis.milestones,
    ];

    return (
      <div
        ref={ref}
        style={{ width: sheetWidth }}
        // `theme-light` (issue #1683) pins this off-screen surface to the LIGHT
        // token palette even when the app is in dark mode — otherwise the sheet
        // stays a fixed `bg-white` while every CSS-var token (ink, surfaces,
        // borders) resolves to its dark value, and the rasterizer captures
        // light-gray ink on a white page (WCAG 1.4.3). The document is designed
        // light; the island keeps it light regardless of the exporter's theme.
        className={`theme-light ${roleBgClass('sheetSurface')} p-6 font-sans text-neutral-text-primary`}
        data-print-page-width-px={printWidth}
        data-print-label-strip-px={layout ? labelStripPx : undefined}
        data-print-week-px={layout && weekPx != null ? weekPx : undefined}
        data-print-chart-content-px={layout ? layout.contentW : undefined}
        data-print-gantt-row-count={layout ? rows.length : undefined}
        data-print-cp-row-count={
          includeCpSummary && cpChain.length > 0 ? cpChain.length : undefined
        }
      >
        {/* Masthead */}
        <header className="mb-3 border-b border-neutral-border pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold leading-tight">{masthead.projectName}</h1>
              <p className="text-xs text-neutral-text-secondary">{masthead.methodSubtitle}</p>
            </div>
            {/* Export-provenance block (issue 1437): org, baseline, export date,
                project key, and workspace URL — so a printed sheet is traceable
                back to the workspace and schedule version it came from. */}
            <div className="text-right text-xs text-neutral-text-secondary">
              {masthead.orgName && <div className="font-medium">{masthead.orgName}</div>}
              {masthead.baselineLabel && <div>{masthead.baselineLabel}</div>}
              <div>Exported {masthead.exportDateLabel}</div>
              {masthead.projectKey && <div className="tppm-mono">{masthead.projectKey}</div>}
              {masthead.workspaceUrl && <div className="tppm-mono">{masthead.workspaceUrl}</div>}
            </div>
          </div>
        </header>

        {/* KPI strip */}
        <div className="mb-4 grid grid-cols-5 gap-2">
          {kpiCells.map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-card border border-neutral-border bg-neutral-surface px-2 py-1.5"
            >
              <div className="text-xs uppercase tracking-wide text-neutral-text-secondary">
                {kpi.label}
              </div>
              <div className="text-sm font-semibold text-neutral-text-primary">{kpi.value}</div>
              {kpi.sub && <div className="text-xs text-neutral-text-secondary">{kpi.sub}</div>}
            </div>
          ))}
        </div>

        {/* Gantt: label column + chart area */}
        {layout ? (
          // `data-print-vmark="gantt"` bounds the whole Gantt block; the rasterizer's
          // vertical paginator (ADR-0276) reads its top and the rows-region top to
          // derive the repeatable header band, and re-composites that band atop each
          // Gantt continuation page so it reads standalone (issue 1694).
          <div data-print-vmark="gantt" className="flex border border-neutral-border">
            {/* Label column */}
            <div
              style={{ width: labelColPx }}
              className="flex-shrink-0 border-r border-neutral-border"
            >
              <div
                style={{ height: HEADER_H }}
                className="flex items-end border-b border-neutral-border px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
              >
                <span className="flex-1">Activity</span>
                {includeOwnerColumn && <span className="w-10 text-right">Owner</span>}
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{ height: ROW_H, paddingLeft: labelIndentPx(row.indentLevel) }}
                  className={`flex items-center gap-1.5 pr-2 text-xs ${
                    row.kind === 'phase' ? 'font-semibold' : ''
                  } text-neutral-text-primary`}
                >
                  {row.isCritical && (
                    <span
                      aria-hidden="true"
                      title="On the critical path"
                      className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${roleBgClass(
                        'criticalBar',
                      )}`}
                    />
                  )}
                  {/* The mono WBS code is the stable join key across sheets, so it is
                      flex-shrink-0 and never clipped; only the name ellipsizes (it
                      never wraps — one row stays one bar-height tall). issue 1440. */}
                  <span
                    className="tppm-mono flex-shrink-0 text-neutral-text-secondary"
                    title={row.wbsCode}
                  >
                    {row.wbsCode}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={row.name}>
                    {row.name}
                  </span>
                  {includeOwnerColumn && row.ownerInitials && (
                    <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-neutral-surface-sunken text-[9px] font-medium text-neutral-text-primary">
                      {row.ownerInitials}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Chart area */}
            <div style={{ width: layout.chartW }} className="relative flex-shrink-0">
              {/* Scale header (month labels) */}
              <div style={{ height: HEADER_H }} className="relative border-b border-neutral-border">
                {monthLabels(layout.scales).map((m) => (
                  <span
                    key={m.label + m.x}
                    style={{ left: m.x }}
                    className="absolute bottom-1 pl-1 text-xs text-neutral-text-secondary"
                  >
                    {m.label}
                  </span>
                ))}
              </div>

              {/* Rows region: gridlines, bars, milestones, data-date line, arrow overlay.
                  `data-print-vmark="gantt-rows"` marks the breakable rows band — the
                  paginator divides its height by `data-print-gantt-row-count` for the
                  row pitch and only ever breaks a page on a row boundary (issue 1694). */}
              <div data-print-vmark="gantt-rows" style={{ height: rowsAreaH }} className="relative">
                {/* Week gridlines */}
                {weekGridlines(layout.scales).map((x, i) => (
                  <span
                    key={`g${i}`}
                    style={{ left: x }}
                    className="absolute top-0 bottom-0 w-px bg-neutral-border"
                  />
                ))}

                {/* Bars + milestones */}
                {rows.map((row, i) => {
                  const top = i * ROW_H;
                  const ext = barExtent(row, layout.scales);
                  if (row.isMilestone) {
                    return (
                      <span
                        key={row.id}
                        style={{
                          left: ext.left + MILESTONE_HALF_PX - MILESTONE_HALF_PX,
                          top: top + (ROW_H - MILESTONE_HALF_PX * 2) / 2,
                          width: MILESTONE_HALF_PX * 2,
                          height: MILESTONE_HALF_PX * 2,
                        }}
                        title={`${row.name} — ${fmtUtcShort(row.start)}`}
                        className={`absolute rotate-45 ${milestoneFillClass(
                          row.milestoneMet ?? false,
                        )}`}
                      />
                    );
                  }
                  const width = Math.max(2, ext.right - ext.left);
                  const fillW = (width * Math.min(100, Math.max(0, row.pctComplete))) / 100;
                  if (row.kind === 'phase') {
                    return (
                      <span
                        key={row.id}
                        style={{ left: ext.left, top: top + ROW_H / 2 - 2, width, height: 4 }}
                        title={row.name}
                        className={`absolute rounded-sm ${roleBgClass('summaryBracket')}`}
                      />
                    );
                  }
                  return (
                    <span
                      key={row.id}
                      style={{
                        left: ext.left,
                        top: top + (ROW_H - BAR_H) / 2,
                        width,
                        height: BAR_H,
                      }}
                      title={`${row.name} · ${row.pctComplete}%`}
                      className={`absolute overflow-hidden rounded-sm border border-neutral-border ${barFillClass(
                        row.riskBand,
                      )}`}
                    >
                      {fillW > 0 && (
                        <span
                          style={{ width: fillW, height: BAR_H }}
                          className={`absolute left-0 top-0 ${roleBgClass('progressFill')}`}
                        />
                      )}
                    </span>
                  );
                })}

                {/* Data-date ("now") line */}
                {dataDateX != null && (
                  <span
                    style={{ left: dataDateX }}
                    title="Data date"
                    className={`absolute top-0 bottom-0 w-0.5 ${roleBgClass('dataDateLine')}`}
                  />
                )}

                {/* Dependency-arrow overlay (issue 1438: hidden when the toggle is off) */}
                {includeArrows && (
                  <svg
                    className="pointer-events-none absolute left-0 top-0"
                    width={layout.chartW}
                    height={rowsAreaH}
                    aria-hidden="true"
                  >
                    {paintLinks.map((link) => {
                      const fi = layout.rowIndex.get(link.fromId);
                      const ti = layout.rowIndex.get(link.toId);
                      if (fi == null || ti == null) return null;
                      const from = barBox(rows[fi], fi * ROW_H + ROW_H / 2, layout.scales);
                      const to = barBox(rows[ti], ti * ROW_H + ROW_H / 2, layout.scales);
                      const offset = channelOffsetPx(channelSeqByLink.get(link.id) ?? 0);
                      const d = fsConnectorPath(from, to, offset);
                      // Hard (driving) links draw at full opacity above soft links so
                      // the critical chain stays readable through arrow crossings.
                      const opacity = link.hard ? 1 : 0.6;
                      return (
                        <g key={link.id}>
                          <path
                            d={d}
                            fill="none"
                            strokeWidth={1}
                            strokeOpacity={opacity}
                            strokeDasharray={link.hard ? undefined : '3 2'}
                            style={{ stroke: arrowColor }}
                          />
                          <polygon
                            points={`${to.left - 5},${to.centerY - 3} ${to.left},${to.centerY} ${
                              to.left - 5
                            },${to.centerY + 3}`}
                            fillOpacity={opacity}
                            style={{ fill: arrowColor }}
                          />
                        </g>
                      );
                    })}
                  </svg>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-card border border-neutral-border bg-neutral-surface px-4 py-10 text-center">
            {/* Empty schedule (issue 1440): the masthead + KPI strip above still
                render (cells read — / 0), so the cover is an intentional, dated
                document rather than a broken/blank page. */}
            <div className="text-sm font-medium text-neutral-text-primary">
              No activities to plot
            </div>
            <div className="mt-1 text-xs text-neutral-text-secondary">
              This schedule has no dated activities in the selected range.
            </div>
          </div>
        )}

        {/* Footer: legend + CP summary + sign-off + watermark */}
        <footer className="mt-4 border-t border-neutral-border pt-2 text-xs text-neutral-text-secondary">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <span className={`inline-block h-2 w-3 rounded-sm ${roleBgClass('criticalBar')}`} />
              Critical
            </span>
            <span className="inline-flex items-center gap-1">
              <span className={`inline-block h-2 w-3 rounded-sm ${roleBgClass('atRiskBar')}`} />
              At risk
            </span>
            <span className="inline-flex items-center gap-1">
              <span className={`inline-block h-2 w-3 rounded-sm ${roleBgClass('onTrackBar')}`} />
              On track
            </span>
            <span className="inline-flex items-center gap-1">
              <span className={`inline-block h-2 w-2 rotate-45 ${roleBgClass('milestoneMet')}`} />
              Milestone
            </span>
          </div>

          {/* Critical-path summary box (issue 1437): the ordered driving chain in a
              bordered card — a lightweight form of Layout B's activity register.
              Each entry shows its WBS + name and inclusive date range; the header
              states that this chain drives the project finish (float = 0). */}
          {includeCpSummary && cpChain.length > 0 && (
            <div
              data-print-vmark="cp"
              className="mt-3 rounded-card border border-neutral-border bg-neutral-surface px-3 py-2"
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-neutral-text-primary">
                  Critical path chain
                </span>
                <span className="text-xs text-neutral-text-secondary">
                  {cpChain.length} {cpChain.length === 1 ? 'activity drives' : 'activities drive'}{' '}
                  the finish date
                </span>
              </div>
              <ol data-print-vmark="cp-list" className="grid grid-cols-2 gap-x-6 gap-y-0.5">
                {cpChain.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-baseline gap-1.5 text-xs text-neutral-text-primary"
                  >
                    <span className="tppm-mono flex-shrink-0 text-neutral-text-secondary">
                      {t.seq}.
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={`${t.wbsCode} ${t.name}`}>
                      <span className="text-neutral-text-secondary">{t.wbsCode}</span> {t.name}
                    </span>
                    <span className="tppm-mono flex-shrink-0 whitespace-nowrap text-neutral-text-secondary">
                      {fmtUtcShort(t.start)}–{fmtUtcShort(t.finish)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* `data-print-vmark="footer"` marks the keep-together sign-off strip: a page
              break may fall at its top but never inside it (ADR-0276, issue 1694). */}
          <div
            data-print-vmark="footer"
            className="mt-2 flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              {masthead.projectName} · Generated {footer.generatedAtLabel}
              {footer.userName ? ` by ${footer.userName}` : ''}
              {footer.contentSha && (
                <>
                  {' · '}
                  <span
                    className="tppm-mono"
                    title="Content fingerprint — identical schedules export the same stamp"
                  >
                    checksum {footer.contentSha}
                  </span>
                </>
              )}
            </span>
            <span>{footer.signOff}</span>
          </div>
          {watermark && <div className="mt-1">{watermark}</div>}
        </footer>
      </div>
    );
  },
);
