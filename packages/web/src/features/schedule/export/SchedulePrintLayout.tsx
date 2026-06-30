/**
 * Off-screen static print surface for the schedule PDF export (ADR-0188, issue 1436).
 *
 * The sibling of `BoardPrintLayout`, with two additions ADR-0188 requires: it
 * re-projects the canvas Gantt as **static DOM + an `<svg>` dependency-arrow
 * overlay**, and it owns its OWN `GanttScaleData` (full project span, a
 * print-width `pxPerDay`, `scrollLeft = 0`) built via the engine's shared
 * geometry layer. It never captures the live dark canvas — it redraws the full
 * timeline in the LIGHT theme at a fixed print width, so the artifact is correct
 * on extent, theme, and scale simultaneously, and the PDF keeps a selectable
 * text layer.
 *
 * Styling uses Design-System tokens only (no raw hex, no shadow utilities) via
 * the `schedulePrintTheme` role→token map, so html-to-image captures the theme's
 * resolved light colors and the design-system-v2 gate stays green. Owners render
 * as initials, never remote avatar images.
 *
 * This is the FOUNDATION surface (issue 1436): a single light sheet that exercises the
 * geometry, theme, and overlay wiring. The full Layout-A composition (masthead
 * polish, KPI strip styling, CP summary box, sign-off + sha) is issue 1437; the
 * 3-page Layout B is issue 1439; week-boundary banding + dense-arrow routing is issue 1440.
 */
import { forwardRef, useMemo } from 'react';
import {
  buildScaleDataFromPxPerDay,
  clampPxPerDay,
  dateToLeft,
  type GanttScaleData,
} from '../engine';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { scheduleExportFooterWatermark } from './scheduleExportEdition';
import {
  barFillClass,
  milestoneFillClass,
  arrowStrokeClass,
  arrowFillClass,
  roleBgClass,
} from './schedulePrintTheme';
import { barBox, barExtent, fsConnectorPath, MILESTONE_HALF_PX } from './scheduleArrowGeometry';
import type { SchedulePrintData, SchedulePrintRow } from './schedulePrintData';
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
 * container then uses the resulting `totalWidth` so bars never clip; wide
 * timelines that exceed the page are handled by the export's horizontal banding.
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
}

/**
 * Off-screen print surface. The parent positions this node out of view; we own
 * only its visual structure. `forwardRef` so `exportSchedulePdf` can hand the
 * node to html-to-image.
 */
export const SchedulePrintLayout = forwardRef<HTMLDivElement, SchedulePrintLayoutProps>(
  function SchedulePrintLayout({ data, paper = 'letter', dataDate }, ref) {
    const watermark = scheduleExportFooterWatermark();
    const { rows, links, kpis, cpChain, masthead, footer } = data;

    const printWidth = PRINT_WIDTH_PX[paper];
    const chartTargetW = printWidth - LABEL_COL_PX - SHEET_PAD_PX * 2;

    const layout = useMemo(() => {
      const span = projectSpan(rows);
      if (!span) return null;
      const scales = buildPrintScale(span.start, span.finish, chartTargetW);
      const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
      return { scales, rowIndex, chartW: scales.totalWidth };
    }, [rows, chartTargetW]);

    const sheetWidth = layout ? LABEL_COL_PX + layout.chartW + SHEET_PAD_PX * 2 : printWidth;
    const rowsAreaH = rows.length * ROW_H;

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
        className={`${roleBgClass('sheetSurface')} p-6 font-sans text-neutral-text-primary`}
      >
        {/* Masthead */}
        <header className="mb-3 border-b border-neutral-border pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold leading-tight">{masthead.projectName}</h1>
              <p className="text-xs text-neutral-text-secondary">{masthead.methodSubtitle}</p>
            </div>
            <div className="text-right text-xs text-neutral-text-secondary">
              {masthead.orgName && <div className="font-medium">{masthead.orgName}</div>}
              {masthead.baselineLabel && <div>{masthead.baselineLabel}</div>}
              <div>Exported {masthead.exportDateLabel}</div>
              {masthead.projectKey && <div className="tppm-mono">{masthead.projectKey}</div>}
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
          <div className="flex border border-neutral-border">
            {/* Label column */}
            <div
              style={{ width: LABEL_COL_PX }}
              className="flex-shrink-0 border-r border-neutral-border"
            >
              <div
                style={{ height: HEADER_H }}
                className="flex items-end border-b border-neutral-border px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
              >
                <span className="flex-1">Activity</span>
                <span className="w-10 text-right">Owner</span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{ height: ROW_H, paddingLeft: 8 + (row.indentLevel - 1) * 12 }}
                  className={`flex items-center gap-1.5 pr-2 text-[11px] ${
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
                  <span className="flex-1 truncate" title={`${row.wbsCode} ${row.name}`}>
                    <span className="text-neutral-text-secondary">{row.wbsCode}</span> {row.name}
                  </span>
                  {row.ownerInitials && (
                    <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-neutral-surface-sunken text-[9px] font-medium text-neutral-text-secondary">
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
                    className="absolute bottom-1 pl-1 text-[10px] text-neutral-text-secondary"
                  >
                    {m.label}
                  </span>
                ))}
              </div>

              {/* Rows region: gridlines, bars, milestones, data-date line, arrow overlay */}
              <div style={{ height: rowsAreaH }} className="relative">
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

                {/* Dependency-arrow overlay */}
                <svg
                  className="pointer-events-none absolute left-0 top-0"
                  width={layout.chartW}
                  height={rowsAreaH}
                  aria-hidden="true"
                >
                  {links.map((link) => {
                    const fi = layout.rowIndex.get(link.fromId);
                    const ti = layout.rowIndex.get(link.toId);
                    if (fi == null || ti == null) return null;
                    const from = barBox(rows[fi], fi * ROW_H + ROW_H / 2, layout.scales);
                    const to = barBox(rows[ti], ti * ROW_H + ROW_H / 2, layout.scales);
                    const d = fsConnectorPath(from, to);
                    return (
                      <g key={link.id}>
                        <path
                          d={d}
                          fill="none"
                          strokeWidth={1}
                          strokeDasharray={link.hard ? undefined : '3 2'}
                          className={arrowStrokeClass(link.hard)}
                        />
                        <polygon
                          points={`${to.left - 5},${to.centerY - 3} ${to.left},${to.centerY} ${
                            to.left - 5
                          },${to.centerY + 3}`}
                          className={arrowFillClass(link.hard)}
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-card border border-neutral-border bg-neutral-surface px-4 py-10 text-center text-sm text-neutral-text-secondary">
            No activities to plot.
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

          {cpChain.length > 0 && (
            <div className="mt-2">
              <span className="font-semibold text-neutral-text-primary">Critical path: </span>
              {cpChain.map((t) => (
                <span key={t.id} className="mr-1">
                  {t.seq}. {t.name} ({fmtUtcShort(t.start)}–{fmtUtcShort(t.finish)})
                  {t.seq < cpChain.length ? ' →' : ''}
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span>
              {masthead.projectName} · Generated {footer.generatedAtLabel}
              {footer.userName ? ` by ${footer.userName}` : ''}
              {footer.contentSha ? ` · ${footer.contentSha}` : ''}
            </span>
            <span>{footer.signOff}</span>
          </div>
          {watermark && <div className="mt-1">{watermark}</div>}
        </footer>
      </div>
    );
  },
);
