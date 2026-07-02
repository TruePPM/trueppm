import { useState } from 'react';
import type { HeatmapResource } from '@/hooks/useResourceHeatmap';
import { HeatmapCell } from './HeatmapCell';
import { HeatmapCellDrawer } from './HeatmapCellDrawer';
import { cellColor } from './cellColor';

interface DrawerState {
  resourceId: string;
  resourceName: string;
  resourceInitials: string;
  resourceColor: string;
  weekIndex: number;
}

interface Props {
  projectId: string;
  weeks: string[];      // ISO week labels e.g. ["2026-W18", ...]
  resources: HeatmapResource[];
}

/** Convert an ISO week label (e.g. "2026-W18") to the Monday date string (YYYY-MM-DD). */
function isoWeekToMonday(weekLabel: string): string {
  const [yearStr, weekStr] = weekLabel.split('-W');
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  // Jan 4 is always in week 1 of the ISO year.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // 1=Mon … 7=Sun
  const weekOneMonday = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400_000);
  const monday = new Date(weekOneMonday.getTime() + (week - 1) * 7 * 86400_000);
  return monday.toISOString().slice(0, 10);
}

function isoWeekToSunday(weekLabel: string): string {
  const monday = new Date(isoWeekToMonday(weekLabel) + 'T00:00:00Z');
  const sunday = new Date(monday.getTime() + 6 * 86400_000);
  return sunday.toISOString().slice(0, 10);
}

/**
 * Heatmap skeleton — matches grid layout so the page doesn't reflow on load.
 */
export function ResourcesHeatmapSkeleton({ cols: _cols }: { cols: number }) {
  return (
    <div className="rounded-card border border-neutral-border overflow-hidden">
      {/* Header row skeleton */}
      <div className="h-9 bg-neutral-surface-sunken border-b border-neutral-border motion-safe:animate-pulse" />
      {/* Person rows skeleton */}
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-[52px] border-b border-neutral-border/40 motion-safe:animate-pulse bg-neutral-surface-raised"
          style={{ opacity: 1 - i * 0.12 }}
        />
      ))}
    </div>
  );
}

/**
 * Week × person utilization heatmap (issue #217, ADR-0042).
 *
 * Desktop: CSS grid with fixed 260px resource column + equal-width week columns.
 * Mobile (< md): collapses to a vertical list with a mini sparkline per person.
 */
export function ResourcesHeatmap({ projectId, weeks, resources }: Props) {
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  function openDrawer(resource: HeatmapResource, weekIndex: number) {
    setDrawer({
      resourceId: resource.id,
      resourceName: resource.name,
      resourceInitials: resource.initials,
      resourceColor: resource.color,
      weekIndex,
    });
  }

  const drawerWeekLabel = drawer ? weeks[drawer.weekIndex] : '';
  const drawerWeekStart = drawer ? isoWeekToMonday(drawerWeekLabel) : '';
  const drawerWeekEnd = drawer ? isoWeekToSunday(drawerWeekLabel) : '';
  const drawerResource = drawer
    ? resources.find((r) => r.id === drawer.resourceId)
    : null;

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Desktop grid (≥ md)                                                 */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="hidden md:block rounded-card border border-neutral-border overflow-x-auto"
        role="grid"
        aria-label="Resource utilization heatmap"
      >
        {/* Header row */}
        <div
          role="row"
          className="grid bg-neutral-surface-sunken border-b border-neutral-border h-9"
          style={{ gridTemplateColumns: `260px repeat(${weeks.length}, minmax(56px, 1fr))` }}
        >
          <div role="columnheader" className="flex items-center px-[14px]">
            <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-text-secondary">
              Resource
            </span>
          </div>
          {weeks.map((w) => {
            const wNum = w.includes('-W') ? `W${w.split('-W')[1]}` : w;
            return (
              <div
                key={w}
                role="columnheader"
                className="flex items-center justify-center px-1"
              >
                <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-text-secondary tppm-mono">
                  {wNum}
                </span>
              </div>
            );
          })}
        </div>

        {/* Person rows */}
        {resources.map((resource) => (
          <div
            key={resource.id}
            role="row"
            className="grid border-b border-neutral-border/40 last:border-0"
            style={{ gridTemplateColumns: `260px repeat(${weeks.length}, minmax(56px, 1fr))` }}
          >
            {/* Resource identity cell */}
            <div
              role="rowheader"
              className="flex items-center gap-2.5 px-[14px] h-[52px]"
            >
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0"
                style={{ backgroundColor: resource.color }}
                aria-hidden="true"
              >
                {resource.initials}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-neutral-text-primary truncate">
                  {resource.name}
                </p>
                {resource.job_role && (
                  <p className="text-[11px] text-neutral-text-secondary truncate">
                    {resource.job_role}
                  </p>
                )}
              </div>
            </div>

            {/* Utilization cells */}
            {resource.util.map((util, i) => (
              <div key={i} role="gridcell" className="flex items-center px-0.5">
                <HeatmapCell
                  util={util}
                  resourceName={resource.name}
                  weekLabel={weeks[i]}
                  onClick={() => openDrawer(resource, i)}
                />
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Mobile sparkline list (< md)                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="md:hidden space-y-px rounded-card border border-neutral-border overflow-hidden">
        {resources.map((resource) => {
          const peakUtil = Math.max(...resource.util);
          const peakWeekIndex = resource.util.indexOf(peakUtil);
          const peakWeekNum = weeks[peakWeekIndex]?.includes('-W')
            ? `W${weeks[peakWeekIndex].split('-W')[1]}`
            : weeks[peakWeekIndex];

          return (
            <button
              key={resource.id}
              type="button"
              onClick={() => openDrawer(resource, peakUtil > 100 ? peakWeekIndex : 0)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-neutral-surface border-b border-neutral-border/40 last:border-0 text-left min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
              aria-label={`${resource.name}${peakUtil > 100 ? `, over-allocated, peak ${peakUtil}% in ${peakWeekNum}` : `, peak ${peakUtil}% in ${peakWeekNum}`}`}
            >
              {/* Avatar */}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0"
                style={{ backgroundColor: resource.color }}
                aria-hidden="true"
              >
                {resource.initials}
              </div>

              {/* Name + peak */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-neutral-text-primary truncate">
                  {resource.name}
                </p>
                <p className="text-xs text-neutral-text-secondary truncate">
                  {resource.job_role || 'Team member'} · peak {peakWeekNum} ({peakUtil}%)
                </p>
              </div>

              {/* Sparkline: 8 colored squares */}
              <div className="flex items-center gap-0.5 shrink-0" aria-hidden="true">
                {resource.util.slice(0, 8).map((u, i) => {
                  const { bg } = cellColor(u);
                  return (
                    <div
                      key={i}
                      className="w-4 h-4 rounded-chip"
                      style={{ backgroundColor: u === 0 ? 'var(--neutral-surface-sunken)' : bg }}
                    />
                  );
                })}
              </div>

              {peakUtil > 100 && (
                <span className="shrink-0 ml-1 text-xs font-medium text-semantic-critical" aria-hidden="true">
                  ⚠
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Cell drawer                                                          */}
      {/* ------------------------------------------------------------------ */}
      {drawer && drawerResource && (
        <HeatmapCellDrawer
          projectId={projectId}
          resourceId={drawer.resourceId}
          resourceName={drawer.resourceName}
          resourceInitials={drawer.resourceInitials}
          resourceColor={drawer.resourceColor}
          weekLabel={drawerWeekLabel}
          weekStart={drawerWeekStart}
          weekEnd={drawerWeekEnd}
          utilPct={drawerResource.util[drawer.weekIndex]}
          onClose={() => setDrawer(null)}
        />
      )}
    </>
  );
}
