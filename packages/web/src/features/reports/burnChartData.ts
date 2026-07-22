import type { ApiSprint } from '@/types';
import { daysBetween, sprintDayOf } from '@/features/sprints/sprintMath';
import type { BurnVariant, BurnMetric, BurnPoint, CombinedPoint } from './hooks/useBurnChart';

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
export interface NormPoint {
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

export interface ScopeChange {
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
export function describeBurnSeries(
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

export function deriveProjectSeries(
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
export function formatAxisDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
