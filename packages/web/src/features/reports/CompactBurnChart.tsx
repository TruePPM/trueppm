import { AreaChart, Area, Line, ResponsiveContainer } from 'recharts';
import type { ApiSprint } from '@/types';
import type { BurnMetric } from './hooks/useBurnChart';
import { CHART_COLORS, type NormPoint } from './burnChartData';

interface CompactBurnChartProps {
  sprint: ApiSprint | undefined;
  metric: BurnMetric;
  points: NormPoint[] | null;
  isLoading: boolean;
  isError: boolean;
  sprintHasNoRealData: boolean;
  iterationLabel: string;
}

/**
 * Compact mode (#1138) — a stripped single-line burndown for the board sprint
 * header. No controls, no export, no section chrome: just the line + a caption.
 * Always sprint-scoped; renders a thin shell while loading. The caption is the
 * accessible read; the SVG is decorative (issue 2175).
 */
export function CompactBurnChart({
  sprint,
  metric,
  points,
  isLoading,
  isError,
  sprintHasNoRealData,
  iterationLabel,
}: CompactBurnChartProps) {
  const unit = metric === 'points' ? 'pts' : 'tasks';
  const committedVal =
    metric === 'points' ? (sprint?.committed_points ?? 0) : (sprint?.committed_task_count ?? 0);
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
    <div className="flex flex-col items-end gap-1" aria-label={`${iterationLabel} burndown`}>
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
