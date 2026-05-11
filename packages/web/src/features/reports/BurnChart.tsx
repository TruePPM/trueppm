import { useMemo, useRef, useState } from 'react';
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
import type { ApiSprint } from '@/types';
import { daysBetween, sprintDayOf } from '@/features/sprints/sprintMath';
import { useBurnChart, type BurnVariant, type BurnMetric, type BurnPoint, type CombinedPoint } from './hooks/useBurnChart';

// ---------------------------------------------------------------------------
// Chart color tokens — resolved at render time from CSS custom properties so
// they work in both light and dark mode. Tailwind classes cannot reach inside
// Recharts SVG, so we use inline `style` props (rule 10).
// ---------------------------------------------------------------------------
const C = {
  actual:    'var(--color-brand-primary)',
  ideal:     'var(--color-neutral-text-disabled)',
  scope:     'var(--color-teal-400, #1D9E75)',
  completed: 'var(--color-semantic-on-track)',
  scopeAdd:  'var(--color-semantic-at-risk)',
  scopeRem:  'var(--color-semantic-critical)',
  today:     'var(--color-semantic-critical)',
  grid:      'rgba(0,0,0,0.06)',
  axisTick:  'var(--color-neutral-text-secondary)',
} as const;

// ---------------------------------------------------------------------------
// Normalised point shape used by all Recharts variants
// ---------------------------------------------------------------------------
interface NormPoint {
  date: string;
  remaining: number;
  completed: number;
  scope: number;
  ideal: number;
}

interface ScopeChange {
  date: string;
  delta: number;
  newScope: number;
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

function deriveSprintSeries(
  sprint: ApiSprint,
  snapshots: import('@/hooks/useSprints').SprintBurnSnapshot[],
  metric: BurnMetric,
): { points: NormPoint[]; scopeChanges: ScopeChange[]; trendAhead: number | null; forecastDate: string | null } {
  const committedVal =
    metric === 'points'
      ? (sprint.committed_points ?? 0)
      : (sprint.committed_task_count ?? 0);
  const totalDays = daysBetween(sprint.start_date, sprint.finish_date) + 1;
  const byDate = new Map(snapshots.map((s) => [s.snapshot_date, s]));

  const points: NormPoint[] = [];
  const changes: ScopeChange[] = [];
  let prevScope = committedVal;

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(sprint.start_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const snap = byDate.get(iso);
    const remaining =
      metric === 'points'
        ? (snap?.remaining_points ?? committedVal)
        : (snap?.remaining_task_count ?? committedVal);
    const completed =
      metric === 'points'
        ? (snap?.completed_points ?? 0)
        : (snap?.completed_task_count ?? 0);
    const scopeDelta =
      metric === 'points'
        ? (snap?.scope_change_points ?? 0)
        : (snap?.scope_change_task_count ?? 0);
    const curScope = committedVal + (snap ? scopeDelta : 0);
    const ideal = committedVal * (1 - i / Math.max(totalDays - 1, 1));

    if (snap && scopeDelta !== 0 && curScope !== prevScope) {
      changes.push({ date: iso, delta: scopeDelta, newScope: curScope });
      prevScope = curScope;
    }

    points.push({ date: iso, remaining, completed, scope: committedVal, ideal });
  }

  const { day: dayIndex, total } = sprintDayOf(sprint.start_date, sprint.finish_date, new Date());
  const idealNow = committedVal * (1 - dayIndex / Math.max(total, 1));
  const latestSnap = points[Math.min(dayIndex - 1, points.length - 1)];
  const actualNow = latestSnap?.remaining ?? committedVal;
  const trendAhead = idealNow - actualNow;
  const burnRate = dayIndex > 0 ? (committedVal - actualNow) / dayIndex : 0;
  const forecastDays = burnRate > 0 ? Math.ceil(actualNow / burnRate) : null;
  const forecastDate =
    forecastDays !== null
      ? (() => {
          const fd = new Date();
          fd.setUTCDate(fd.getUTCDate() + forecastDays);
          return fd.toISOString().slice(0, 10);
        })()
      : null;

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
interface TooltipPayload {
  payload?: NormPoint;
  active?: boolean;
  label?: string;
}

function BurnTooltip({ active, payload, label, variant, metric, scopeChanges }: TooltipPayload & {
  variant: BurnVariant;
  metric: BurnMetric;
  scopeChanges: ScopeChange[];
}) {
  if (!active || !payload) return null;
  const pt = payload as unknown as NormPoint;
  const unit = metric === 'points' ? 'pts' : 'tasks';
  const change = scopeChanges.find((c) => c.date === label);
  const idealVal = pt.ideal ?? 0;
  const delta = variant === 'burndown' ? idealVal - pt.remaining : 0;
  const deltaLabel = delta >= 0 ? `${Math.round(delta)} ${unit} ahead` : `${Math.round(-delta)} ${unit} behind`;
  const deltaColor = delta >= 0 ? 'text-semantic-on-track' : 'text-semantic-critical';

  return (
    <div className="bg-neutral-surface border border-neutral-border rounded-md p-3 text-xs shadow-none">
      <p className="font-semibold text-neutral-text-primary mb-1.5">
        {label ? formatAxisDate(label) : ''}
      </p>
      {variant !== 'burnup' && (
        <p className="text-neutral-text-secondary">
          Remaining <span className="tppm-mono text-neutral-text-primary ml-1">{Math.round(pt.remaining)} {unit}</span>
        </p>
      )}
      {variant !== 'burndown' && (
        <p className="text-neutral-text-secondary">
          Completed <span className="tppm-mono text-neutral-text-primary ml-1">{Math.round(pt.completed)} {unit}</span>
        </p>
      )}
      {variant === 'burndown' && (
        <p className="text-neutral-text-secondary">
          Ideal <span className="tppm-mono text-neutral-text-primary ml-1">{Math.round(idealVal)} {unit}</span>
        </p>
      )}
      {variant === 'burndown' && <p className={`mt-1 font-medium ${deltaColor}`}>{deltaLabel}</p>}
      {change && (
        <p className={`mt-1 font-medium ${change.delta > 0 ? 'text-semantic-at-risk' : 'text-semantic-critical'}`}>
          {change.delta > 0 ? '+' : ''}{change.delta} {unit} scope change
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
      fill={C.today}
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
}

export function BurnChart({ projectId, sprintId, defaultVariant = 'burndown' }: BurnChartProps) {
  const [variant, setVariant] = useState<BurnVariant>(defaultVariant);
  const [metric, setMetric] = useState<BurnMetric>('tasks');
  const [since, setSince] = useState<string | undefined>();
  const [until, setUntil] = useState<string | undefined>();
  const chartRef = useRef<HTMLDivElement>(null);

  const isSprintCtx = !!sprintId;

  // --- Sprint data ---
  const sprintQuery = useSprintBurndown(sprintId ?? null);
  // Auto-derive sprint metric from committed_points so the series uses the right
  // unit even though the selector is hidden in sprint context.
  const sprintMetric: BurnMetric =
    isSprintCtx && sprintQuery.data
      ? (sprintQuery.data.sprint.committed_points ?? 0) > 0 ? 'points' : 'tasks'
      : metric;
  const sprintResult = useMemo(() => {
    if (!isSprintCtx || !sprintQuery.data) return null;
    return deriveSprintSeries(sprintQuery.data.sprint, sprintQuery.data.snapshots, sprintMetric);
  }, [isSprintCtx, sprintQuery.data, sprintMetric]);

  // --- Project data ---
  const burnQuery = useBurnChart(isSprintCtx ? null : projectId, variant, metric, since, until);
  const projectResult = useMemo(() => {
    if (isSprintCtx || !burnQuery.data?.series.length) return null;
    return deriveProjectSeries(burnQuery.data.series, variant);
  }, [isSprintCtx, burnQuery.data, variant]);

  const isLoading = isSprintCtx ? sprintQuery.isLoading : burnQuery.isLoading;
  const isError = isSprintCtx ? sprintQuery.isError : burnQuery.isError;
  const points = isSprintCtx ? (sprintResult?.points ?? null) : (projectResult?.points ?? null);
  const scopeChanges = isSprintCtx ? (sprintResult?.scopeChanges ?? []) : (projectResult?.scopeChanges ?? []);
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
    (sprintQuery.data.sprint.start_date > today ||
      sprintQuery.data.snapshots.length === 0);
  const showEmpty = isEmpty || sprintHasNoRealData;

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
    await new Promise<void>((res) => { img.onload = () => res(); });
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [img.width, img.height] });
    pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height);
    pdf.save(`burn-${variant}-${today}.pdf`);
  };

  // Chart shared config
  const axisStyle = { fontSize: 11, fill: C.axisTick, fontFamily: 'JetBrains Mono, monospace' };
  const chartMargin = { top: 8, right: 16, left: 0, bottom: 0 };

  const sharedTooltip = (
    <Tooltip
      content={
        <BurnTooltip
          variant={variant}
          metric={effectiveMetric}
          scopeChanges={scopeChanges}
        />
      }
    />
  );

  const sharedGrid = <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={C.grid} />;
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
  const sharedYAxis = (
    <YAxis
      tick={axisStyle}
      tickLine={false}
      axisLine={false}
      width={40}
    />
  );

  const todayLine = (
    <ReferenceLine
      x={today}
      stroke={C.today}
      strokeDasharray="3 3"
      strokeWidth={1}
      label={<TodayLabel />}
    />
  );

  const scopeDots = scopeChanges.map((c) => (
    <ReferenceDot
      key={c.date}
      x={c.date}
      y={variant === 'burndown' || variant === 'combined' ? 0 : 0}
      r={5}
      fill={c.delta > 0 ? C.scopeAdd : C.scopeRem}
      stroke="var(--color-neutral-surface)"
      strokeWidth={2}
      aria-label={`Scope change ${c.date}: ${c.delta > 0 ? '+' : ''}${c.delta} ${effectiveMetric}`}
    />
  ));

  const heading = isSprintCtx ? 'Sprint Burndown' : 'Burn Chart';

  return (
    <section
      aria-labelledby="burn-chart-heading"
      className="rounded-lg border border-neutral-border bg-neutral-surface flex flex-col"
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
              className="h-9 rounded-md border border-neutral-border bg-neutral-surface text-xs text-neutral-text-primary px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              aria-label="Metric"
            >
              <option value="tasks">Tasks</option>
              <option value="points">Story points</option>
            </select>
          )}
          <div className="relative group">
            <button
              className="h-9 px-3 rounded-md border border-neutral-border bg-neutral-surface text-xs font-medium text-neutral-text-primary flex items-center gap-1.5 hover:bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
              disabled={isLoading || showEmpty || isError}
              aria-haspopup="menu"
              aria-label="Export chart"
              onClick={() => {}} // dropdown opens via group-focus-within below
            >
              <span aria-hidden="true">↓</span> Export
            </button>
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-40 bg-neutral-surface border border-neutral-border rounded-md shadow-none overflow-hidden z-10 hidden group-hover:block group-focus-within:block"
            >
              <button
                role="menuitem"
                onClick={() => void exportPng()}
                className="w-full text-left px-3 py-2 text-xs text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Download PNG
              </button>
              <button
                role="menuitem"
                onClick={() => void exportPdf()}
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
        <div role="group" aria-label="Chart variant" className="flex rounded-full border border-neutral-border overflow-hidden">
          {(['burndown', 'burnup', 'combined'] as BurnVariant[]).map((v) => (
            <button
              key={v}
              role="radio"
              aria-checked={variant === v}
              onClick={() => setVariant(v)}
              className={[
                'px-3 h-8 text-xs font-medium focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-brand-primary',
                variant === v
                  ? 'bg-brand-primary text-white'
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
          <div className="flex items-center justify-center gap-3 h-48 text-xs text-semantic-at-risk" aria-live="polite">
            <span>⚠ Couldn&apos;t load chart data.</span>
            <button
              onClick={() => isSprintCtx ? void sprintQuery.refetch() : void burnQuery.refetch()}
              className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Retry
            </button>
          </div>
        )}
        {showEmpty && !isError && <ChartEmpty isSprintCtx={isSprintCtx} sprint={sprintQuery.data?.sprint} />}
        {!isLoading && !isError && !showEmpty && points && (
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
                  stroke={C.actual}
                  fill={C.actual}
                  fillOpacity={0.10}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  name="Remaining"
                />
                <Line
                  type="linear"
                  dataKey="ideal"
                  stroke={C.ideal}
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
                  stroke={C.completed}
                  fill={C.completed}
                  fillOpacity={0.10}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  name="Completed"
                />
                <Line
                  type="monotone"
                  dataKey="scope"
                  stroke={C.scope}
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
                  stroke={C.completed}
                  fill={C.completed}
                  fillOpacity={0.08}
                  strokeWidth={1.5}
                  dot={false}
                  name="Completed"
                />
                <Line
                  type="monotone"
                  dataKey="remaining"
                  stroke={C.actual}
                  strokeWidth={2}
                  dot={false}
                  name="Remaining"
                />
                <Line
                  type="linear"
                  dataKey="scope"
                  stroke={C.scope}
                  strokeDasharray="5 4"
                  strokeWidth={1}
                  dot={false}
                  name="Total scope"
                />
                <Line
                  type="linear"
                  dataKey="ideal"
                  stroke={C.ideal}
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
        )}
      </div>

      {/* Sprint trending callout */}
      {isSprintCtx && trendAhead !== null && !isEmpty && !isLoading && (
        <p className={`px-4 py-2 border-t border-neutral-border text-xs ${trendAhead >= 0 ? 'text-semantic-on-track' : 'text-semantic-at-risk'}`}>
          Trending{' '}
          <span className="tppm-mono">{Math.abs(Math.round(trendAhead))}</span>{' '}
          {effectiveMetric === 'points' ? 'pts' : 'tasks'}{' '}
          {trendAhead >= 0 ? 'ahead' : 'behind'} of ideal
          {forecastDate && (
            <span className="float-right text-neutral-text-secondary">
              Forecast close: <span className="tppm-mono">{forecastDate}</span>
            </span>
          )}
        </p>
      )}

      {/* Legend */}
      {!isLoading && !isError && !isEmpty && (
        <div className="flex flex-wrap items-center gap-4 px-4 pb-4 pt-2 text-[11px] text-neutral-text-secondary">
          <LegendItem color={C.actual} dashed={false} label="Actual" />
          {(variant === 'burnup' || variant === 'combined') && (
            <LegendItem color={C.completed} dashed={false} label="Completed" />
          )}
          {(variant === 'burndown' || variant === 'combined') && (
            <LegendItem color={C.ideal} dashed label="Ideal" />
          )}
          {(variant === 'burnup' || variant === 'combined') && (
            <LegendItem color={C.scope} dashed label="Total scope" />
          )}
          {scopeChanges.some((c) => c.delta > 0) && (
            <span className="flex items-center gap-1">
              <span style={{ color: C.scopeAdd }} aria-hidden="true">◉</span> Scope added
            </span>
          )}
          {scopeChanges.some((c) => c.delta < 0) && (
            <span className="flex items-center gap-1">
              <span style={{ color: C.scopeRem }} aria-hidden="true">◎</span> Scope removed
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
          x1="0" y1="1" x2="20" y2="1"
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
    <div className="animate-pulse flex flex-col gap-3 h-[320px] justify-end pb-6">
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
}: {
  isSprintCtx: boolean;
  sprint?: ApiSprint;
}) {
  if (isSprintCtx && sprint) {
    const now = new Date().toISOString().slice(0, 10);
    if (sprint.start_date > now) {
      return (
        <div className="flex items-center justify-center h-48 text-xs text-neutral-text-secondary" role="status">
          Sprint starts {sprint.start_date} · Check back then to track burn.
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-48 text-xs text-neutral-text-secondary" role="status">
        No snapshots yet. Data is captured daily starting from activation.
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 h-48 text-center" role="status">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true" className="text-neutral-text-disabled">
        <rect x="4" y="20" width="10" height="17" rx="2" fill="currentColor" opacity="0.4" />
        <rect x="15" y="10" width="10" height="27" rx="2" fill="currentColor" opacity="0.4" />
        <rect x="26" y="3"  width="10" height="34" rx="2" fill="currentColor" opacity="0.4" />
      </svg>
      <p className="text-sm font-medium text-neutral-text-primary">No tasks to chart yet</p>
      <p className="text-xs text-neutral-text-secondary">Add tasks to this project to start tracking progress.</p>
    </div>
  );
}
