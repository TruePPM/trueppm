import { useEffect, useRef, useState } from 'react';
import type { ApiSprint } from '@/types';
import type { BurnVariant, BurnMetric } from './hooks/useBurnChart';
import { CHART_COLORS, type ScopeChange } from './burnChartData';

/**
 * Export dropdown (PNG / PDF) for the burn chart. Open/close is state-driven so
 * it works on touch and in browsers that do not focus a `<button>` on click
 * (Safari/Firefox on macOS); CSS group-hover stays a progressive enhancement
 * for pointer users. Outside-click and Escape dismiss it (issue 1607).
 */
export function ExportMenu({
  disabled,
  onExportPng,
  onExportPdf,
}: {
  disabled: boolean;
  onExportPng: () => void;
  onExportPdf: () => void;
}) {
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exportMenuOpen]);

  return (
    <div className="relative group" ref={exportMenuRef}>
      <button
        type="button"
        className="h-9 px-3 rounded-control border border-neutral-border bg-neutral-surface text-xs font-medium text-neutral-text-primary flex items-center gap-1.5 hover:bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={exportMenuOpen}
        aria-label="Export chart"
        onClick={() => setExportMenuOpen((open) => !open)}
      >
        <span aria-hidden="true">↓</span> Export
      </button>
      <div
        role="menu"
        // State drives the explicit open (click/touch, keyboard Enter/
        // Space on the trigger, and Escape/outside-click to dismiss);
        // group-hover stays as a progressive enhancement for pointer
        // users. group-focus-within is deliberately NOT used — it would
        // re-show the menu whenever the focused trigger is focused, so
        // Escape could never dismiss it for a keyboard user (issue 1607).
        className={[
          'absolute right-0 top-full mt-1 w-40 bg-neutral-surface border border-neutral-border rounded-card shadow-none overflow-hidden z-10',
          exportMenuOpen ? 'block' : 'hidden group-hover:block',
        ].join(' ')}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setExportMenuOpen(false);
            onExportPng();
          }}
          className="w-full text-left px-3 py-2 text-xs text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          Download PNG
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setExportMenuOpen(false);
            onExportPdf();
          }}
          className="w-full text-left px-3 py-2 text-xs text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          Download PDF
        </button>
      </div>
    </div>
  );
}

/**
 * The controls row: the burndown / burnup / combined variant radio group plus
 * either the project date-range pickers or, in sprint context, the read-only
 * sprint window.
 */
export function BurnChartControls({
  variant,
  onVariantChange,
  isSprintCtx,
  sprint,
  since,
  onSinceChange,
  until,
  onUntilChange,
}: {
  variant: BurnVariant;
  onVariantChange: (v: BurnVariant) => void;
  isSprintCtx: boolean;
  sprint: ApiSprint | undefined;
  since: string | undefined;
  onSinceChange: (v: string | undefined) => void;
  until: string | undefined;
  onUntilChange: (v: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-neutral-surface-raised">
      <div
        role="group"
        aria-label="Chart variant"
        className="flex rounded-full border border-neutral-border overflow-hidden"
      >
        {(['burndown', 'burnup', 'combined'] as BurnVariant[]).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={variant === v}
            onClick={() => onVariantChange(v)}
            className={[
              'px-3 h-8 text-xs font-medium focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-brand-primary',
              variant === v
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'bg-neutral-surface text-neutral-text-primary hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            {v === 'burndown' ? 'Burn down' : v === 'burnup' ? 'Burn up' : 'Combined'}
          </button>
        ))}
      </div>
      {!isSprintCtx ? (
        <div className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
          <input
            type="date"
            value={since ?? ''}
            onChange={(e) => onSinceChange(e.target.value || undefined)}
            className="h-8 rounded border border-neutral-border bg-neutral-surface text-xs px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
            aria-label="From date"
          />
          <span aria-hidden="true">→</span>
          <input
            type="date"
            value={until ?? ''}
            onChange={(e) => onUntilChange(e.target.value || undefined)}
            className="h-8 rounded border border-neutral-border bg-neutral-surface text-xs px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
            aria-label="To date"
          />
        </div>
      ) : sprint ? (
        <p className="text-xs text-neutral-text-secondary tppm-mono">
          {sprint.start_date} → {sprint.finish_date}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Sprint trending callout — "Trending N pts ahead/behind of ideal" plus an
 * optional linear finish-date forecast. Rendered only in sprint context when a
 * trend is available (the parent owns that gate).
 */
export function SprintTrendCallout({
  trendAhead,
  metric,
  forecastDate,
}: {
  trendAhead: number;
  metric: BurnMetric;
  forecastDate: string | null;
}) {
  return (
    <p
      className={`px-4 py-2 border-t border-neutral-border text-xs ${trendAhead >= 0 ? 'text-semantic-on-track' : 'text-semantic-at-risk'}`}
    >
      Trending <span className="tppm-mono">{Math.abs(Math.round(trendAhead))}</span>{' '}
      {metric === 'points' ? 'pts' : 'tasks'} {trendAhead >= 0 ? 'ahead' : 'behind'} of ideal
      {forecastDate && (
        <span className="float-right text-neutral-text-secondary">
          Forecast close: <span className="tppm-mono">{forecastDate}</span>
        </span>
      )}
    </p>
  );
}

/** The chart legend — one row per plotted series, plus scope-change glyphs. */
export function BurnLegend({
  variant,
  scopeChanges,
}: {
  variant: BurnVariant;
  scopeChanges: ScopeChange[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-4 pb-4 pt-2 text-xs text-neutral-text-secondary">
      <LegendItem color={CHART_COLORS.actual} dashed={false} label="Actual" />
      {(variant === 'burnup' || variant === 'combined') && (
        <LegendItem color={CHART_COLORS.completed} dashed={false} label="Completed" />
      )}
      {(variant === 'burndown' || variant === 'combined') && (
        <LegendItem color={CHART_COLORS.ideal} dashed label="Ideal" />
      )}
      {(variant === 'burnup' || variant === 'combined') && (
        <LegendItem color={CHART_COLORS.scope} dashed label="Total scope" />
      )}
      {scopeChanges.some((c) => c.delta > 0) && (
        <span className="flex items-center gap-1">
          <span style={{ color: CHART_COLORS.scopeAdd }} aria-hidden="true">
            ◉
          </span>{' '}
          Scope added
        </span>
      )}
      {scopeChanges.some((c) => c.delta < 0) && (
        <span className="flex items-center gap-1">
          <span style={{ color: CHART_COLORS.scopeRem }} aria-hidden="true">
            ◎
          </span>{' '}
          Scope removed
        </span>
      )}
    </div>
  );
}

function LegendItem({ color, dashed, label }: { color: string; dashed: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="20" height="2" aria-hidden="true">
        <line
          x1="0"
          y1="1"
          x2="20"
          y2="1"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '4 3' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

/** Loading placeholder for the chart area — a set of pulsing baseline rules. */
export function ChartSkeleton() {
  return (
    <div className="motion-safe:animate-pulse flex flex-col gap-3 h-[320px] justify-end pb-6">
      <div className="h-0.5 bg-neutral-surface-raised rounded w-full" />
      <div className="h-0.5 bg-neutral-surface-raised rounded w-5/6" />
      <div className="h-0.5 bg-neutral-surface-raised rounded w-2/3" />
      <div className="h-0.5 bg-neutral-surface-raised rounded w-1/2" />
      <div className="h-0.5 bg-neutral-surface-raised rounded w-1/3" />
    </div>
  );
}

/**
 * Empty state for the chart area — a sprint-specific message (future sprint or
 * an active sprint with no snapshots yet) or the generic project no-data card.
 */
export function ChartEmpty({
  isSprintCtx,
  sprint,
  iterationLabel,
}: {
  isSprintCtx: boolean;
  sprint?: ApiSprint;
  iterationLabel: string;
}) {
  if (isSprintCtx && sprint) {
    const now = new Date().toISOString().slice(0, 10);
    if (sprint.start_date > now) {
      return (
        <div
          className="flex items-center justify-center h-48 text-xs text-neutral-text-secondary"
          role="status"
        >
          {iterationLabel} starts {sprint.start_date} · Check back then to track burn.
        </div>
      );
    }
    return (
      <div
        className="flex items-center justify-center h-48 text-xs text-neutral-text-secondary"
        role="status"
      >
        No snapshots yet. Data is captured daily starting from activation.
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 h-48 text-center" role="status">
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        className="text-neutral-text-disabled"
      >
        <rect x="4" y="20" width="10" height="17" rx="2" fill="currentColor" opacity="0.4" />
        <rect x="15" y="10" width="10" height="27" rx="2" fill="currentColor" opacity="0.4" />
        <rect x="26" y="3" width="10" height="34" rx="2" fill="currentColor" opacity="0.4" />
      </svg>
      <p className="text-sm font-medium text-neutral-text-primary">No tasks to chart yet</p>
      <p className="text-xs text-neutral-text-secondary">
        Add tasks to this project to start tracking progress.
      </p>
    </div>
  );
}
