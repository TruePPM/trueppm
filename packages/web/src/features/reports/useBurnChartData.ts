import { useMemo, useState } from 'react';
import { useSprintBurndown } from '@/hooks/useSprints';
import { forecastScopeCaption } from '@/features/sprints/sprintMath';
import { useBurnChart, type BurnVariant, type BurnMetric } from './hooks/useBurnChart';
import {
  describeBurnSeries,
  deriveProjectSeries,
  deriveSprintSeries,
  type NormPoint,
  type ScopeChange,
} from './burnChartData';

/**
 * In sprint context the metric selector is hidden, so the unit is auto-derived
 * from `committed_points`: a sprint that committed points burns points, one that
 * didn't burns task count. Outside sprint context the user's choice stands.
 */
function resolveSprintMetric(
  isSprintCtx: boolean,
  committedPoints: number | null | undefined,
  metric: BurnMetric,
): BurnMetric {
  if (!isSprintCtx) return metric;
  return (committedPoints ?? 0) > 0 ? 'points' : 'tasks';
}

/**
 * A sprint that hasn't started, or an active one with no snapshots yet, has no
 * real data to draw. `deriveSprintSeries` always emits a point per day, so the
 * generic `isEmpty` never fires in sprint context — this is the separate gate
 * that surfaces those two UI states.
 */
function hasNoSprintData(
  isSprintCtx: boolean,
  data: { sprint: { start_date: string }; snapshots: unknown[] } | undefined,
  today: string,
): boolean {
  if (!isSprintCtx || !data) return false;
  return data.sprint.start_date > today || data.snapshots.length === 0;
}

/**
 * Story points are opt-in; a project that never estimated renders a flat zero
 * line that reads as "nothing happened" rather than "nothing was estimated".
 */
function isAllZeroPoints(
  points: NormPoint[] | null,
  metric: BurnMetric,
  isSprintCtx: boolean,
  isLoading: boolean,
): boolean {
  if (isLoading || isSprintCtx || metric !== 'points') return false;
  if (!points || points.length === 0) return false;
  return points.every((p) => p.remaining === 0 && p.completed === 0);
}

interface BurnSeriesResult {
  points: NormPoint[];
  scopeChanges: ScopeChange[];
  trendAhead?: number | null;
}

/**
 * Collapse the two data sources (sprint burndown vs project burn series) into
 * the single shape the chart renders. Pure — the queries stay in the hook, so
 * this is the piece that is cheap to reason about and to unit-test.
 */
function deriveBurnState(opts: {
  isSprintCtx: boolean;
  sprintResult: BurnSeriesResult | null;
  projectResult: BurnSeriesResult | null;
  isLoading: boolean;
  isError: boolean;
  metric: BurnMetric;
  sprintMetric: BurnMetric;
  variant: BurnVariant;
}) {
  const { isSprintCtx, sprintResult, projectResult, isLoading, isError, metric, variant } = opts;
  const active = isSprintCtx ? sprintResult : projectResult;
  const points = active?.points ?? null;
  const scopeChanges = active?.scopeChanges ?? [];
  const isEmpty = !isLoading && !isError && (!points || points.length === 0);
  const effectiveMetric = isSprintCtx ? opts.sprintMetric : metric;
  const trendAhead = sprintResult?.trendAhead ?? null;
  return {
    isLoading,
    isError,
    points,
    scopeChanges,
    isEmpty,
    effectiveMetric,
    trendAhead,
    allZeroPoints: isAllZeroPoints(points, metric, isSprintCtx, isLoading),
    // sr-only alternative for the chart SVG (issue 2175) — see describeBurnSeries.
    chartSummary:
      points && points.length > 0
        ? describeBurnSeries(points, variant, effectiveMetric, scopeChanges, trendAhead)
        : '',
  };
}

/**
 * Every value the burn chart renders, derived from whichever data source is in
 * play (sprint burndown vs project burn series) so the component itself stays a
 * layout shell.
 */
export function useBurnChartData(opts: {
  projectId?: string;
  sprintId?: string;
  variant: BurnVariant;
  metric: BurnMetric;
}) {
  const { projectId, sprintId, variant, metric } = opts;
  const [since, setSince] = useState<string | undefined>();
  const [until, setUntil] = useState<string | undefined>();

  const isSprintCtx = !!sprintId;
  const today = new Date().toISOString().slice(0, 10);

  const sprintQuery = useSprintBurndown(sprintId ?? null);
  const sprintMetric = resolveSprintMetric(
    isSprintCtx,
    sprintQuery.data?.sprint.committed_points,
    metric,
  );
  const sprintResult = useMemo(() => {
    if (!isSprintCtx || !sprintQuery.data) return null;
    return deriveSprintSeries(sprintQuery.data.sprint, sprintQuery.data.snapshots, sprintMetric);
  }, [isSprintCtx, sprintQuery.data, sprintMetric]);

  const burnQuery = useBurnChart(isSprintCtx ? null : projectId, variant, metric, since, until);
  const projectResult = useMemo(() => {
    if (isSprintCtx || !burnQuery.data?.series.length) return null;
    return deriveProjectSeries(burnQuery.data.series, variant);
  }, [isSprintCtx, burnQuery.data, variant]);

  const derived = useMemo(
    () =>
      deriveBurnState({
        isSprintCtx,
        sprintResult,
        projectResult,
        isLoading: isSprintCtx ? sprintQuery.isLoading : burnQuery.isLoading,
        isError: isSprintCtx ? sprintQuery.isError : burnQuery.isError,
        metric,
        sprintMetric,
        variant,
      }),
    [
      isSprintCtx,
      sprintResult,
      projectResult,
      sprintQuery.isLoading,
      sprintQuery.isError,
      burnQuery.isLoading,
      burnQuery.isError,
      metric,
      sprintMetric,
      variant,
    ],
  );
  const sprintHasNoRealData = hasNoSprintData(isSprintCtx, sprintQuery.data, today);

  return {
    isSprintCtx,
    today,
    sprint: sprintQuery.data?.sprint,
    since,
    setSince,
    until,
    setUntil,
    ...derived,
    sprintHasNoRealData,
    showEmpty: derived.isEmpty || sprintHasNoRealData,
    forecastDate: sprintResult?.forecastDate ?? null,
    // Forecast transparency (ADR-0102 §2): when the sprint has pending
    // (un-accepted) injections, the burn series reflects accepted scope only.
    // Shared copy so it can't word differently from the SprintPanel caption.
    scopeCaption: isSprintCtx
      ? forecastScopeCaption(sprintQuery.data?.sprint.pending_count ?? 0)
      : null,
    refetch: () => (isSprintCtx ? void sprintQuery.refetch() : void burnQuery.refetch()),
  };
}
