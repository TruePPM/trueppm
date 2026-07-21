import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart,
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
  ResponsiveContainer,
} from 'recharts';
import { useSprintBurndown } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { ApiSprint } from '@/types';
import { daysBetween, forecastScopeCaption, sprintDayOf } from '@/features/sprints/sprintMath';
import {
  useBurnChart,
  type BurnVariant,
  type BurnMetric,
  type BurnPoint,
  type CombinedPoint,
} from './hooks/useBurnChart';

// ---------------------------------------------------------------------------
// Chart color tokens — resolved at render time from CSS custom properties so
// they work in both light and dark mode. Tailwind classes cannot reach inside
// Recharts SVG, so we use inline `style` props (rule 10).
//
// The Design-System v2 tokens are bare RGB channel triples
// (`--neutral-border: 230 225 214`) meant for Tailwind's `rgb(var(--x)/<alpha>)`
// composition, so an SVG `fill`/`stroke` must wrap them in `rgb(var(--…))` — a
// bare `var(--neutral-border)` resolves to the invalid `230 225 214`. And the
// token names carry NO `--color-` prefix (that prefix is a Tailwind v4 `@theme`
// convention we don't use). Referencing `var(--color-neutral-border)` was both
// wrong-named and unwrapped, so every token silently fell back to SVG-default
// black — illegible on the dark navy chart surface (issue 1791). The correct
// `rgb(var(--…))` form matches the schedule PDF export (schedulePrintTheme.ts).
// ---------------------------------------------------------------------------
export const CHART_COLORS = {
  actual: 'rgb(var(--brand-primary))',
  // Ideal reference line — a neutral, mode-aware mark. `--neutral-text-disabled`
  // (#A09D99) was only 2.70:1 as a graphical object, a WCAG 1.4.11 fail (issue
  // 2207); `--chart-neutral` is the ≥3:1 neutral-mark token (3.61:1 light / ~7:1
  // dark) that exists precisely for burndown / Monte-Carlo neutral marks.
  ideal: 'rgb(var(--chart-neutral))',
  // Total-scope line — a neutral informational reference; `--info` is a distinct,
  // mode-aware blue that reads apart from the sage actual line and the violet
  // completed area (unlike the old dead `--color-teal-400`, which only rendered
  // via its hex fallback and sat too close to the on-track green).
  scope: 'var(--info)',
  // Completed series — a distinct violet hue (WCAG 1.4.1 use-of-color, issue 2207).
  // `--semantic-on-track` is BYTE-IDENTICAL to `--brand-primary` (the `actual`
  // series) in BOTH themes — sage-700 in light, sage-400 in dark — so the two
  // curves and their legend swatches were the same green, distinguishable by
  // label alone. `--violet` (#6D4AC4) is an existing DS token that reads clearly
  // apart from the sage actual line, the blue scope line, and the neutral ideal
  // line, so all series (and their legend swatches) differ by hue, not just text.
  completed: 'var(--violet)',
  scopeAdd: 'rgb(var(--semantic-at-risk))',
  scopeRem: 'rgb(var(--semantic-critical))',
  today: 'rgb(var(--semantic-critical))',
  // Mode-aware so the gridlines adapt to the .dark token swap. A hardcoded
  // rgba(0,0,0,…) wash renders as invisible black-on-navy in dark mode (WCAG
  // 1.4.11); the neutral-border token is the same grid stroke FlowAnalyticsPanel
  // uses (issue 1638).
  grid: 'rgb(var(--neutral-border))',
  axisTick: 'rgb(var(--neutral-text-secondary))',
} as const;

/**
 * Fill/stroke for a scope-change ReferenceDot. Scope ADDED renders a filled disc
 * (amber) haloed by the surface color; scope REMOVED renders HOLLOW — a
 * transparent fill with a colored (critical) ring — so the two are distinguished
 * by SHAPE, not hue alone (WCAG 1.4.1, issue 2207). The hollow ring mirrors the
 * legend's ◎ glyph for "Scope removed", while the filled disc mirrors ◉ for
 * "Scope added".
 */
export function scopeDotStyle(delta: number): { fill: string; stroke: string } {
  return delta > 0
    ? { fill: CHART_COLORS.scopeAdd, stroke: 'rgb(var(--neutral-surface))' }
    : { fill: 'transparent', stroke: CHART_COLORS.scopeRem };
}

// ---------------------------------------------------------------------------
// Normalised point shape used by all Recharts variants
// ---------------------------------------------------------------------------
interface NormPoint {
  date: string;
  // `null` once the sprint passes its last real snapshot (and any future day):
  // the actual-remaining line must STOP at the last known data point rather than
  // ride flat at the committed value across the sprint-end corner, otherwise it
  // visibly diverges from the ideal line that declines to zero (issue 1249).
  // Recharts skips null y-values (connectNulls defaults false), ending the line.
  remaining: number | null;
  completed: number | null;
  // `null` after the last snapshot too — the burnup total-scope line shares the
  // completed line's extent and must end with the data, not flat-line (issue 1279).
  scope: number | null;
  ideal: number;
}

interface ScopeChange {
  date: string;
  delta: number;
  newScope: number;
}

/**
 * A screen-reader summary of the burn series (WCAG 1.1.1, house rule 176). The
 * chart SVG is `aria-hidden`, so this sentence is the only accessible read of
 * "committed vs remaining vs trend" (issue 2175). Derived entirely from the
 * already-computed series, so it can never drift from what the chart draws.
 */
function describeBurnSeries(
  points: NormPoint[],
  variant: BurnVariant,
  metric: BurnMetric,
  scopeChanges: ScopeChange[],
  trendAhead: number | null,
): string {
  const unit = metric === 'points' ? 'story points' : 'tasks';
  const lastWith = (key: 'remaining' | 'completed' | 'scope'): NormPoint | undefined =>
    [...points].reverse().find((p) => p[key] != null);
  const asOf = points[points.length - 1]?.date;
  const parts: string[] = [];

  if (variant === 'burndown' || variant === 'combined') {
    const p = lastWith('remaining');
    if (p) {
      parts.push(
        `${Math.round(p.remaining as number)} ${unit} remaining versus an ideal of ${Math.round(p.ideal)}`,
      );
    }
  }
  if (variant === 'burnup' || variant === 'combined') {
    const c = lastWith('completed');
    const s = lastWith('scope');
    if (c && s) {
      parts.push(
        `${Math.round(c.completed as number)} of ${Math.round(s.scope as number)} ${unit} completed`,
      );
    }
  }
  if (trendAhead != null) {
    const n = Math.abs(Math.round(trendAhead));
    parts.push(`${n} ${unit} ${trendAhead >= 0 ? 'ahead of' : 'behind'} the ideal pace`);
  }
  const added = scopeChanges.filter((c) => c.delta > 0).length;
  const removed = scopeChanges.filter((c) => c.delta < 0).length;
  if (added || removed) {
    const bits: string[] = [];
    if (added) bits.push(`${added} scope ${added === 1 ? 'addition' : 'additions'}`);
    if (removed) bits.push(`${removed} scope ${removed === 1 ? 'removal' : 'removals'}`);
    parts.push(bits.join(' and '));
  }

  const label =
    variant === 'burnup' ? 'Burn-up' : variant === 'combined' ? 'Combined burn' : 'Burndown';
  const body = parts.length ? parts.join('; ') : 'no data yet';
  return `${label} chart${asOf ? ` as of ${asOf}` : ''}: ${body}.`;
}

function deriveProjectSeries(
  series: BurnPoint[] | CombinedPoint[],
  variant: BurnVariant,
): { points: NormPoint[]; scopeChanges: ScopeChange[] } {
  if (variant === 'combined') {
    const pts = (series as CombinedPoint[]).map((p) => ({
      date: p.date,
      remaining: p.remaining,
      completed: p.completed,
      scope: p.total,
      ideal: p.ideal,
    }));
    const changes = pts.reduce<ScopeChange[]>((acc, p, i) => {
      if (i > 0 && p.scope !== pts[i - 1].scope) {
        acc.push({ date: p.date, delta: p.scope - pts[i - 1].scope, newScope: p.scope });
      }
      return acc;
    }, []);
    return { points: pts, scopeChanges: changes };
  }

  const raw = series as BurnPoint[];
  const pts = raw.map((p) => ({
    date: p.date,
    remaining: variant === 'burndown' ? p.actual : p.scope - p.actual,
    completed: variant === 'burnup' ? p.actual : p.scope - p.actual,
    scope: p.scope,
    ideal: p.ideal,
  }));
  const changes = pts.reduce<ScopeChange[]>((acc, p, i) => {
    if (i > 0 && p.scope !== pts[i - 1].scope) {
      acc.push({ date: p.date, delta: p.scope - pts[i - 1].scope, newScope: p.scope });
    }
    return acc;
  }, []);
  return { points: pts, scopeChanges: changes };
}

/**
 * Number of day-grid STEPS in a sprint window, i.e. the divisor that maps the
 * ideal burndown from `committed` at step 0 down to exactly `0` at the final
 * grid row. For an inclusive day count of N rows there are N-1 steps. Floored
 * at 1 so a single-day sprint never divides by zero.
 *
 * This is the single source of truth for the ideal-line slope: both the plotted
 * `ideal` series and the trend ("X ahead/behind of ideal") number derive from
 * it, so the drawn dashed line and the spoken trend can never disagree by an
 * off-by-one (issue 1249).
 */
export function idealSlopeDenominator(startIso: string, finishIso: string): number {
  const inclusiveDays = daysBetween(startIso, finishIso) + 1;
  return Math.max(inclusiveDays - 1, 1);
}

/**
 * Ideal remaining at a given 0-based day index on the burndown grid: a straight
 * line from `committed` (index 0) to `0` (final index). Shared by the plotted
 * series and the trend calc so both lines live on ONE coordinate system.
 */
export function idealRemainingAt(committed: number, dayIndex: number, denom: number): number {
  return committed * (1 - dayIndex / denom);
}

/**
 * Value of a burn series (remaining / completed / scope) on one grid day, shared
 * by all three lines so their extent stays identical. Day 0 anchors at `anchor`
 * (the committed value, or 0 for the completed line) so the actual and ideal
 * lines coincide at the start; a day WITH a snapshot uses the carried snapshot
 * value; a gap day BEFORE the last snapshot holds the previous value forward; a
 * day AFTER the last snapshot — or any day when there are no snapshots at all
 * (`isAfterData`) — is null so the line ENDS with the data rather than
 * flat-lining to the sprint-end/zero corner (issue 1249).
 */
function projectedDayValue(
  hasSnap: boolean,
  isFirstDay: boolean,
  isAfterData: boolean,
  anchor: number,
  carried: number,
): number | null {
  if (hasSnap) return carried;
  if (isFirstDay) return anchor;
  if (isAfterData) return null;
  return carried;
}

/** Add `days` to today and return the ISO (UTC) date string. */
function isoDaysFromToday(days: number): string {
  const fd = new Date();
  fd.setUTCDate(fd.getUTCDate() + days);
  return fd.toISOString().slice(0, 10);
}

/**
 * "X ahead/behind" trend plus a linear finish-date forecast for a sprint
 * burndown. Uses the SAME slope denominator as the plotted ideal line so the
 * number matches the visual gap (issue 1249). `dayIndex` is 1-based
 * (`sprintDayOf`); the grid is 0-based, so the elapsed grid row is `dayIndex - 1`.
 */
function computeSprintTrend(
  sprint: ApiSprint,
  committedVal: number,
  denom: number,
  totalDays: number,
  points: NormPoint[],
): { trendAhead: number; forecastDate: string | null } {
  const { day: dayIndex } = sprintDayOf(sprint.start_date, sprint.finish_date, new Date());
  const elapsedRow = Math.min(dayIndex - 1, totalDays - 1);
  const idealNow = idealRemainingAt(committedVal, elapsedRow, denom);
  const latestSnap = points[Math.max(0, elapsedRow)];
  const actualNow = latestSnap?.remaining ?? committedVal;
  const trendAhead = idealNow - actualNow;
  const burnRate = dayIndex > 0 ? (committedVal - actualNow) / dayIndex : 0;
  const forecastDays = burnRate > 0 ? Math.ceil(actualNow / burnRate) : null;
  return {
    trendAhead,
    forecastDate: forecastDays !== null ? isoDaysFromToday(forecastDays) : null,
  };
}

export function deriveSprintSeries(
  sprint: ApiSprint,
  snapshots: import('@/hooks/useSprints').SprintBurnSnapshot[],
  metric: BurnMetric,
): {
  points: NormPoint[];
  scopeChanges: ScopeChange[];
  trendAhead: number | null;
  forecastDate: string | null;
} {
  const committedVal =
    metric === 'points' ? (sprint.committed_points ?? 0) : (sprint.committed_task_count ?? 0);
  const totalDays = daysBetween(sprint.start_date, sprint.finish_date) + 1;
  const denom = idealSlopeDenominator(sprint.start_date, sprint.finish_date);
  const byDate = new Map(snapshots.map((s) => [s.snapshot_date, s]));

  // The actual-remaining line is only meaningful up to the last day that has a
  // snapshot. Past that the team simply hasn't burned those days yet, so the
  // line must END rather than ride flat at the committed value across the
  // sprint-end/zero corner (which is what made it diverge from the ideal line —
  // issue 1249). Day 0 is always anchored at `committed` (= ideal at day 0) so
  // the two lines coincide at the start; gaps BEFORE the last snapshot carry the
  // previous known remaining forward; days AFTER it are null (no line).
  const lastSnapIso = snapshots.reduce<string | null>(
    (max, s) => (max === null || s.snapshot_date > max ? s.snapshot_date : max),
    null,
  );

  const points: NormPoint[] = [];
  const changes: ScopeChange[] = [];
  let prevScope = committedVal;
  let carriedRemaining = committedVal;
  let carriedCompleted = 0;
  // The cumulative total-scope value, carried across gap days like the remaining
  // and completed lines so the burnup scope line is a step function that holds its
  // level between snapshots rather than dropping back to the committed baseline.
  let carriedScope = committedVal;

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(sprint.start_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const snap = byDate.get(iso);

    if (snap) {
      carriedRemaining = metric === 'points' ? snap.remaining_points : snap.remaining_task_count;
      carriedCompleted = metric === 'points' ? snap.completed_points : snap.completed_task_count;
    }

    // Anchor day 0 at the committed value even with no snapshot (sprint start =
    // full backlog). Beyond the last real snapshot, leave a gap so the actual
    // line stops instead of flat-lining to the sprint-end corner. `projectedDayValue`
    // encodes this shared extent rule for all three lines (see its docstring).
    const pastLastSnap = lastSnapIso !== null && iso > lastSnapIso;
    const isFirstDay = i === 0;
    const isAfterData = pastLastSnap || lastSnapIso === null;
    const remaining = projectedDayValue(
      !!snap,
      isFirstDay,
      isAfterData,
      committedVal,
      carriedRemaining,
    );
    const completed = projectedDayValue(!!snap, isFirstDay, isAfterData, 0, carriedCompleted);

    const scopeDelta =
      metric === 'points' ? (snap?.scope_change_points ?? 0) : (snap?.scope_change_task_count ?? 0);
    // scope_change_points is the CUMULATIVE signed delta from the committed baseline
    // as of this snapshot, so the total scope on a snapshot day is committed + delta.
    const curScope = committedVal + (snap ? scopeDelta : 0);
    if (snap) carriedScope = curScope;
    const ideal = idealRemainingAt(committedVal, i, denom);

    if (snap && scopeDelta !== 0 && curScope !== prevScope) {
      changes.push({ date: iso, delta: scopeDelta, newScope: curScope });
      prevScope = curScope;
    }

    // Total-scope line: the burnup's load-bearing series. It must STEP UP when scope
    // is injected mid-sprint (issue 1279) — the previous flat `committedVal` hid exactly the
    // scope creep the burnup exists to expose. Shares the completed line's extent
    // (anchored at committed on day 0, carried across gaps, null after the last
    // snapshot so it ends with the data, issue-1249 shape).
    const scope = projectedDayValue(!!snap, isFirstDay, isAfterData, committedVal, carriedScope);

    points.push({ date: iso, remaining, completed, scope, ideal });
  }

  const { trendAhead, forecastDate } = computeSprintTrend(
    sprint,
    committedVal,
    denom,
    totalDays,
    points,
  );

  return { points, scopeChanges: changes, trendAhead, forecastDate };
}

// ---------------------------------------------------------------------------
// Axis helpers
// ---------------------------------------------------------------------------
function formatAxisDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------
// Recharts passes a custom tooltip `content` element an ARRAY of series
// entries; the plotted data row lives at `payload[0].payload`. Typing it as a
// bare NormPoint (and casting the array straight to that) read `undefined` off
// every field, so the tooltip printed 0 for Remaining/Ideal/Completed
// regardless of the data (issue 1304).
interface TooltipPayload {
  payload?: ReadonlyArray<{ payload?: NormPoint }>;
  active?: boolean;
  label?: string;
}

export function BurnTooltip({
  active,
  payload,
  label,
  variant,
  metric,
  scopeChanges,
}: TooltipPayload & {
  variant: BurnVariant;
  metric: BurnMetric;
  scopeChanges: ScopeChange[];
}) {
  const pt = payload?.[0]?.payload;
  if (!active || !pt) return null;
  const unit = metric === 'points' ? 'pts' : 'tasks';
  const change = scopeChanges.find((c) => c.date === label);
  const idealVal = pt.ideal ?? 0;
  // remaining/completed are null on days past the last snapshot (issue 1249);
  // treat those as no-data in the tooltip rather than rendering NaN.
  const remainingVal = pt.remaining ?? 0;
  const completedVal = pt.completed ?? 0;
  const delta = variant === 'burndown' ? idealVal - remainingVal : 0;
  const deltaLabel =
    delta >= 0 ? `${Math.round(delta)} ${unit} ahead` : `${Math.round(-delta)} ${unit} behind`;
  const deltaColor = delta >= 0 ? 'text-semantic-on-track' : 'text-semantic-critical';

  return (
    <div className="bg-neutral-surface border border-neutral-border rounded-card p-3 text-xs shadow-none">
      <p className="font-semibold text-neutral-text-primary mb-1.5">
        {label ? formatAxisDate(label) : ''}
      </p>
      {variant !== 'burnup' && (
        <p className="text-neutral-text-secondary">
          Remaining{' '}
          <span className="tppm-mono text-neutral-text-primary ml-1">
            {Math.round(remainingVal)} {unit}
          </span>
        </p>
      )}
      {variant !== 'burndown' && (
        <p className="text-neutral-text-secondary">
          Completed{' '}
          <span className="tppm-mono text-neutral-text-primary ml-1">
            {Math.round(completedVal)} {unit}
          </span>
        </p>
      )}
      {variant === 'burndown' && (
        <p className="text-neutral-text-secondary">
          Ideal{' '}
          <span className="tppm-mono text-neutral-text-primary ml-1">
            {Math.round(idealVal)} {unit}
          </span>
        </p>
      )}
      {variant === 'burndown' && <p className={`mt-1 font-medium ${deltaColor}`}>{deltaLabel}</p>}
      {change && (
        <p
          className={`mt-1 font-medium ${change.delta > 0 ? 'text-semantic-at-risk' : 'text-semantic-critical'}`}
        >
          {change.delta > 0 ? '+' : ''}
          {change.delta} {unit} scope change
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today label for ReferenceLine
// ---------------------------------------------------------------------------
function TodayLabel({ viewBox }: { viewBox?: { x: number; y: number } }) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x}
      y={viewBox.y - 4}
      textAnchor="middle"
      fill={CHART_COLORS.today}
      fontSize={10}
      fontWeight={500}
      aria-hidden="true"
    >
      TODAY
    </text>
  );
}

// ---------------------------------------------------------------------------
// Main BurnChart component
// ---------------------------------------------------------------------------
export interface BurnChartProps {
  /** Project id — used when not in sprint context. */
  projectId?: string;
  /** Sprint id — when set, switches to sprint-scoped burndown. */
  sprintId?: string;
  defaultVariant?: BurnVariant;
  /**
   * Compact mode (#1138) — renders ONLY a small single burndown line (no
   * variant radio, metric selector, date pickers, export, or section chrome)
   * at a fixed small size, plus a "N of M pts left" caption. Used in the board
   * sprint header. Requires `sprintId` (sprint context); a no-op fallback
   * renders nothing when no sprint data is available.
   */
  compact?: boolean;
}

export function BurnChart({
  projectId,
  sprintId,
  defaultVariant = 'burndown',
  compact = false,
}: BurnChartProps) {
  const [variant, setVariant] = useState<BurnVariant>(defaultVariant);
  const [metric, setMetric] = useState<BurnMetric>('tasks');
  const [since, setSince] = useState<string | undefined>();
  const [until, setUntil] = useState<string | undefined>();
  const chartRef = useRef<HTMLDivElement>(null);
  // Export menu open/close is state-driven so it works on touch and in
  // browsers that do not focus a <button> on click (Safari/Firefox on macOS).
  // CSS group-hover stays as a progressive enhancement for pointer users.
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

  const isSprintCtx = !!sprintId;
  const itl = useIterationLabel(projectId);

  // --- Sprint data ---
  const sprintQuery = useSprintBurndown(sprintId ?? null);
  // Auto-derive sprint metric from committed_points so the series uses the right
  // unit even though the selector is hidden in sprint context.
  const sprintMetric: BurnMetric =
    isSprintCtx && sprintQuery.data
      ? (sprintQuery.data.sprint.committed_points ?? 0) > 0
        ? 'points'
        : 'tasks'
      : metric;
  const sprintResult = useMemo(() => {
    if (!isSprintCtx || !sprintQuery.data) return null;
    return deriveSprintSeries(sprintQuery.data.sprint, sprintQuery.data.snapshots, sprintMetric);
  }, [isSprintCtx, sprintQuery.data, sprintMetric]);

  // Forecast transparency (ADR-0102 §2): when the sprint has pending
  // (un-accepted) injections, the burn series reflects accepted scope only.
  // Shared copy so it can't word differently from the SprintPanel caption.
  const scopeCaption = isSprintCtx
    ? forecastScopeCaption(sprintQuery.data?.sprint.pending_count ?? 0)
    : null;

  // --- Project data ---
  const burnQuery = useBurnChart(isSprintCtx ? null : projectId, variant, metric, since, until);
  const projectResult = useMemo(() => {
    if (isSprintCtx || !burnQuery.data?.series.length) return null;
    return deriveProjectSeries(burnQuery.data.series, variant);
  }, [isSprintCtx, burnQuery.data, variant]);

  const isLoading = isSprintCtx ? sprintQuery.isLoading : burnQuery.isLoading;
  const isError = isSprintCtx ? sprintQuery.isError : burnQuery.isError;
  const points = isSprintCtx ? (sprintResult?.points ?? null) : (projectResult?.points ?? null);
  // Memoized so the `?? []` fallback keeps a stable identity — otherwise the
  // chart-summary useMemo (and the legend) would recompute every render.
  const scopeChanges = useMemo<ScopeChange[]>(
    () => (isSprintCtx ? (sprintResult?.scopeChanges ?? []) : (projectResult?.scopeChanges ?? [])),
    [isSprintCtx, sprintResult, projectResult],
  );
  const isEmpty = !isLoading && !isError && (!points || points.length === 0);

  // Metric selector: in sprint context, auto-derive and hide; in project context, show
  const effectiveMetric = isSprintCtx ? sprintMetric : metric;

  // Sprint trending / forecast
  const trendAhead = sprintResult?.trendAhead ?? null;
  const forecastDate = sprintResult?.forecastDate ?? null;

  // All-zero story points warning
  const allZeroPoints =
    !isLoading &&
    metric === 'points' &&
    !isSprintCtx &&
    !!points &&
    points.length > 0 &&
    points.every((p) => p.remaining === 0 && p.completed === 0);

  const today = new Date().toISOString().slice(0, 10);

  // Sprint-specific empty states: future sprint or active sprint with no snapshots yet.
  // deriveSprintSeries always generates a point per day, so isEmpty is always false for
  // sprint context — we need a separate gate to surface these UI states.
  const sprintHasNoRealData =
    isSprintCtx &&
    !!sprintQuery.data &&
    (sprintQuery.data.sprint.start_date > today || sprintQuery.data.snapshots.length === 0);
  const showEmpty = isEmpty || sprintHasNoRealData;

  // sr-only alternative for the chart SVG (issue 2175) — see describeBurnSeries.
  const chartSummary = useMemo(
    () =>
      points && points.length > 0
        ? describeBurnSeries(points, variant, effectiveMetric, scopeChanges, trendAhead)
        : '',
    [points, variant, effectiveMetric, scopeChanges, trendAhead],
  );

  // Export helpers
  const exportPng = async () => {
    const { toPng } = await import('html-to-image');
    if (!chartRef.current) return;
    const dataUrl = await toPng(chartRef.current, { pixelRatio: 2 });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `burn-${variant}-${today}.png`;
    a.click();
  };

  const exportPdf = async () => {
    const { toPng } = await import('html-to-image');
    const { jsPDF } = await import('jspdf');
    if (!chartRef.current) return;
    const dataUrl = await toPng(chartRef.current, { pixelRatio: 2 });
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((res) => {
      img.onload = () => res();
    });
    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'px',
      format: [img.width, img.height],
    });
    pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height);
    pdf.save(`burn-${variant}-${today}.pdf`);
  };

  // Chart shared config
  const axisStyle = {
    fontSize: 11,
    fill: CHART_COLORS.axisTick,
    fontFamily: 'JetBrains Mono, monospace',
  };
  const chartMargin = { top: 8, right: 16, left: 0, bottom: 0 };

  const sharedTooltip = (
    <Tooltip
      content={
        <BurnTooltip variant={variant} metric={effectiveMetric} scopeChanges={scopeChanges} />
      }
    />
  );

  const sharedGrid = (
    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
  );
  const sharedXAxis = (
    <XAxis
      dataKey="date"
      tickFormatter={formatAxisDate}
      tick={axisStyle}
      tickLine={false}
      axisLine={false}
      minTickGap={40}
    />
  );
  const sharedYAxis = <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={40} />;

  const todayLine = (
    <ReferenceLine
      x={today}
      stroke={CHART_COLORS.today}
      strokeDasharray="3 3"
      strokeWidth={1}
      label={<TodayLabel />}
    />
  );

  const scopeDots = scopeChanges.map((c) => {
    const style = scopeDotStyle(c.delta);
    return (
      <ReferenceDot
        key={c.date}
        x={c.date}
        y={0}
        r={5}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={2}
        aria-label={`Scope change ${c.date}: ${c.delta > 0 ? '+' : ''}${c.delta} ${effectiveMetric}`}
      />
    );
  });

  const heading = isSprintCtx ? `${itl.singular} Burndown` : 'Burn Chart';

  // -------------------------------------------------------------------------
  // Compact mode (#1138) — a stripped single-line burndown for the board
  // sprint header. No controls, no export, no section chrome: just the line +
  // a caption. Always sprint-scoped; renders a thin shell while loading.
  // -------------------------------------------------------------------------
  if (compact) {
    const sprint = sprintQuery.data?.sprint;
    const unit = effectiveMetric === 'points' ? 'pts' : 'tasks';
    const committedVal =
      effectiveMetric === 'points'
        ? (sprint?.committed_points ?? 0)
        : (sprint?.committed_task_count ?? 0);
    // The latest day that actually has a remaining value drives the caption.
    // Grid rows past the last snapshot are now null (issue 1249), so we can't
    // read the final row blindly — walk back to the last non-null remaining,
    // falling back to the committed value (PLANNED / not started).
    const lastRemaining =
      points?.reduce<number>((last, p) => p.remaining ?? last, committedVal) ?? committedVal;

    // Caption is split into prose + a single contiguous numeric chunk so the
    // `.tppm-mono` count never swaps font mid-token (rule 8c). The mono chunk
    // is the count + unit together (mirroring the BurnTooltip pattern).
    let captionLead: string | null;
    let captionNum: string;
    let captionTrail: string;
    if (sprint?.state === 'COMPLETED') {
      captionLead = null;
      captionNum = '';
      captionTrail = 'Closed';
    } else if (sprintHasNoRealData) {
      // PLANNED / future sprint with no snapshots yet — a flat baseline.
      captionLead = 'Not started — ';
      captionNum = `${committedVal} ${unit}`;
      captionTrail = ' committed';
    } else {
      captionLead = '';
      captionNum = `${Math.round(lastRemaining)} of ${committedVal} ${unit}`;
      captionTrail = ' left';
    }

    return (
      <div className="flex flex-col items-end gap-1" aria-label={`${itl.singular} burndown`}>
        <div className="w-[220px] h-[64px]">
          {isLoading ? (
            <div
              className="h-full w-full rounded bg-neutral-surface-sunken motion-safe:animate-pulse"
              aria-hidden="true"
            />
          ) : isError ? (
            <div className="flex h-full w-full items-center justify-center text-xs text-neutral-text-secondary">
              Chart unavailable
            </div>
          ) : points && points.length > 0 ? (
            // The caption below is the accessible read; the SVG is decorative (issue 2175).
            <div aria-hidden="true" className="h-full w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <Area
                    type="monotone"
                    dataKey="remaining"
                    stroke={CHART_COLORS.actual}
                    fill={CHART_COLORS.actual}
                    fillOpacity={0.1}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="Remaining"
                  />
                  <Line
                    type="linear"
                    dataKey="ideal"
                    stroke={CHART_COLORS.ideal}
                    strokeDasharray="4 3"
                    strokeWidth={1}
                    dot={false}
                    isAnimationActive={false}
                    name="Ideal"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-neutral-text-secondary">
              No data yet
            </div>
          )}
        </div>
        <p className="text-xs text-neutral-text-secondary">
          {captionLead}
          {captionNum && <span className="tppm-mono text-neutral-text-primary">{captionNum}</span>}
          {captionTrail}
        </p>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="burn-chart-heading"
      className="rounded-card border border-neutral-border bg-neutral-surface flex flex-col"
    >
      {/* Card header */}
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b border-neutral-border">
        <h2 id="burn-chart-heading" className="text-sm font-semibold text-neutral-text-primary">
          {heading}
        </h2>
        <div className="flex items-center gap-2">
          {!isSprintCtx && (
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as BurnMetric)}
              className="h-9 rounded-control border border-neutral-border bg-neutral-surface text-xs text-neutral-text-primary px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              aria-label="Metric"
            >
              <option value="tasks">Tasks</option>
              <option value="points">Story points</option>
            </select>
          )}
          <div className="relative group" ref={exportMenuRef}>
            <button
              type="button"
              className="h-9 px-3 rounded-control border border-neutral-border bg-neutral-surface text-xs font-medium text-neutral-text-primary flex items-center gap-1.5 hover:bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
              disabled={isLoading || showEmpty || isError}
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
                  void exportPng();
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
                  void exportPdf();
                }}
                className="w-full text-left px-3 py-2 text-xs text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Download PDF
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Controls row */}
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
              onClick={() => setVariant(v)}
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
              onChange={(e) => setSince(e.target.value || undefined)}
              className="h-8 rounded border border-neutral-border bg-neutral-surface text-xs px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              aria-label="From date"
            />
            <span aria-hidden="true">→</span>
            <input
              type="date"
              value={until ?? ''}
              onChange={(e) => setUntil(e.target.value || undefined)}
              className="h-8 rounded border border-neutral-border bg-neutral-surface text-xs px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              aria-label="To date"
            />
          </div>
        ) : sprintQuery.data ? (
          <p className="text-xs text-neutral-text-secondary tppm-mono">
            {sprintQuery.data.sprint.start_date} → {sprintQuery.data.sprint.finish_date}
          </p>
        ) : null}
      </div>

      {/* Null story-points banner */}
      {allZeroPoints && (
        <div className="px-4 py-2 bg-semantic-info-bg border-b border-neutral-border flex items-center gap-2 text-xs text-neutral-text-secondary">
          <span aria-hidden="true">ⓘ</span>
          Most tasks have no story point estimates.{' '}
          <button
            type="button"
            onClick={() => setMetric('tasks')}
            className="underline text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Use task count
          </button>
        </div>
      )}

      {/* Chart area */}
      <div ref={chartRef} className="px-4 py-4">
        {isLoading && <ChartSkeleton />}
        {isError && (
          <div
            className="flex items-center justify-center gap-3 h-48 text-xs text-semantic-at-risk"
            aria-live="polite"
          >
            <span>⚠ Couldn&apos;t load chart data.</span>
            <button
              type="button"
              onClick={() => (isSprintCtx ? void sprintQuery.refetch() : void burnQuery.refetch())}
              className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Retry
            </button>
          </div>
        )}
        {showEmpty && !isError && (
          <ChartEmpty
            isSprintCtx={isSprintCtx}
            sprint={sprintQuery.data?.sprint}
            iterationLabel={itl.singular}
          />
        )}
        {!isLoading && !isError && !showEmpty && points && (
          <p className="sr-only">{chartSummary}</p>
        )}
        {!isLoading && !isError && !showEmpty && points && (
          <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={320}>
              {variant === 'burndown' ? (
                <AreaChart data={points} margin={chartMargin}>
                  {sharedGrid}
                  {sharedXAxis}
                  {sharedYAxis}
                  {sharedTooltip}
                  <Area
                    type="monotone"
                    dataKey="remaining"
                    stroke={CHART_COLORS.actual}
                    fill={CHART_COLORS.actual}
                    fillOpacity={0.1}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    name="Remaining"
                  />
                  <Line
                    type="linear"
                    dataKey="ideal"
                    stroke={CHART_COLORS.ideal}
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    dot={false}
                    name="Ideal"
                  />
                  {todayLine}
                  {scopeDots}
                </AreaChart>
              ) : variant === 'burnup' ? (
                <AreaChart data={points} margin={chartMargin}>
                  {sharedGrid}
                  {sharedXAxis}
                  {sharedYAxis}
                  {sharedTooltip}
                  <Area
                    type="monotone"
                    dataKey="completed"
                    stroke={CHART_COLORS.completed}
                    fill={CHART_COLORS.completed}
                    fillOpacity={0.1}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    name="Completed"
                  />
                  <Line
                    type="monotone"
                    dataKey="scope"
                    stroke={CHART_COLORS.scope}
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    dot={false}
                    name="Total scope"
                  />
                  {todayLine}
                  {scopeDots}
                </AreaChart>
              ) : (
                // Combined
                <ComposedChart data={points} margin={chartMargin}>
                  {sharedGrid}
                  {sharedXAxis}
                  {sharedYAxis}
                  {sharedTooltip}
                  <Area
                    type="monotone"
                    dataKey="completed"
                    stroke={CHART_COLORS.completed}
                    fill={CHART_COLORS.completed}
                    fillOpacity={0.08}
                    strokeWidth={1.5}
                    dot={false}
                    name="Completed"
                  />
                  <Line
                    type="monotone"
                    dataKey="remaining"
                    stroke={CHART_COLORS.actual}
                    strokeWidth={2}
                    dot={false}
                    name="Remaining"
                  />
                  <Line
                    type="linear"
                    dataKey="scope"
                    stroke={CHART_COLORS.scope}
                    strokeDasharray="5 4"
                    strokeWidth={1}
                    dot={false}
                    name="Total scope"
                  />
                  <Line
                    type="linear"
                    dataKey="ideal"
                    stroke={CHART_COLORS.ideal}
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    dot={false}
                    name="Ideal"
                  />
                  {todayLine}
                  {scopeDots}
                </ComposedChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Sprint trending callout */}
      {isSprintCtx && trendAhead !== null && !isEmpty && !isLoading && (
        <p
          className={`px-4 py-2 border-t border-neutral-border text-xs ${trendAhead >= 0 ? 'text-semantic-on-track' : 'text-semantic-at-risk'}`}
        >
          Trending <span className="tppm-mono">{Math.abs(Math.round(trendAhead))}</span>{' '}
          {effectiveMetric === 'points' ? 'pts' : 'tasks'} {trendAhead >= 0 ? 'ahead' : 'behind'} of
          ideal
          {forecastDate && (
            <span className="float-right text-neutral-text-secondary">
              Forecast close: <span className="tppm-mono">{forecastDate}</span>
            </span>
          )}
        </p>
      )}

      {/* Pending-scope forecast caveat (ADR-0102 §2) — shown whenever the sprint
          has un-accepted injections, regardless of trend/empty state. */}
      {isSprintCtx && scopeCaption && !isLoading && (
        <p className="px-4 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary">
          <span aria-hidden="true">○</span> {scopeCaption}
        </p>
      )}

      {/* Legend */}
      {!isLoading && !isError && !isEmpty && (
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
      )}
    </section>
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

function ChartSkeleton() {
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

function ChartEmpty({
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
