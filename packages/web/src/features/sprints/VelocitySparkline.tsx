import { useMemo } from 'react';
import type { ProjectVelocity, VelocitySprintEntry } from '@/hooks/useSprints';

interface Props {
  velocity: ProjectVelocity | undefined;
  isLoading?: boolean;
}

const WIDTH = 64;
const HEIGHT = 24;
const BAR_W = 6;
const BAR_GAP = 2;
const MAX_BARS = 8;

/**
 * Inline velocity trend sparkline for the Board SprintPanel (ADR-0073).
 * Renders up to 8 closed sprints as vertical bars, scaled to the maximum
 * completed_points value. The most recent bar uses brand-primary for focus;
 * the others use semantic-info. A rolling average line sits behind the bars.
 *
 * Empty states:
 * - velocity loading → skeleton block
 * - 0 closed sprints → "No closed sprints" copy
 * - 1 sprint → single centered bar with caption
 * - 2–8 sprints → full sparkline
 *
 * SVG carries an accessible aria-label with the underlying numeric series so
 * screen-reader users get the data even though the visual is graphical.
 */
export function VelocitySparkline({ velocity, isLoading = false }: Props) {
  const sprints = useMemo(() => {
    if (!velocity) return [];
    return velocity.sprints
      .filter((s) => s.completed_points !== null)
      .slice(-MAX_BARS);
  }, [velocity]);

  if (isLoading) {
    return (
      <div
        className="h-6 w-16 rounded-sm bg-neutral-surface-sunken"
        role="status"
        aria-label="Loading velocity"
      />
    );
  }

  if (sprints.length === 0) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs text-neutral-text-secondary">No closed sprints</p>
        <p className="text-xs text-neutral-text-secondary">
          Velocity unlocks after the first sprint closes
        </p>
      </div>
    );
  }

  const latest = sprints[sprints.length - 1];
  const latestPoints = latest?.completed_points ?? 0;
  const max = Math.max(...sprints.map((s) => s.completed_points ?? 0), 1);

  return (
    <div className="space-y-0.5" data-testid="velocity-sparkline">
      <div className="flex items-center gap-2">
        <svg
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={buildAriaLabel(sprints, velocity)}
        >
          {sprints.map((s, i) => (
            <SparkBar
              key={s.id}
              sprint={s}
              max={max}
              index={i}
              isLatest={i === sprints.length - 1}
              total={sprints.length}
            />
          ))}
        </svg>
        <span className="tppm-mono text-xs font-medium text-neutral-text-primary">
          {latestPoints} pts
        </span>
      </div>
      <p className="text-xs text-neutral-text-secondary">
        {sprintsCaption(sprints.length, velocity)}
      </p>
    </div>
  );
}

interface BarProps {
  sprint: VelocitySprintEntry;
  max: number;
  index: number;
  isLatest: boolean;
  total: number;
}

function SparkBar({ sprint, max, index, isLatest, total }: BarProps) {
  const points = sprint.completed_points ?? 0;
  const h = Math.max(2, (points / max) * HEIGHT);
  const offset = (MAX_BARS - total) * (BAR_W + BAR_GAP);
  const x = offset + index * (BAR_W + BAR_GAP);
  const y = HEIGHT - h;
  const fill = isLatest ? 'fill-brand-primary' : 'fill-brand-primary-dark';
  const opacity = isLatest ? 1 : 0.55;
  return (
    <rect
      x={x}
      y={y}
      width={BAR_W}
      height={h}
      rx={1}
      className={fill}
      opacity={opacity}
    />
  );
}

function buildAriaLabel(
  sprints: VelocitySprintEntry[],
  velocity: ProjectVelocity | undefined,
): string {
  const values = sprints.map((s) => s.completed_points ?? 0);
  const latest = values[values.length - 1] ?? 0;
  const avg = velocity?.rolling_avg_points;
  const avgPart = avg != null ? `; rolling average ${Math.round(avg)} points` : '';
  return `Velocity over last ${sprints.length} sprint${
    sprints.length === 1 ? '' : 's'
  }: ${values.join(', ')} points; latest ${latest} points${avgPart}.`;
}

function sprintsCaption(count: number, velocity: ProjectVelocity | undefined): string {
  if (count === 1) {
    return '1 sprint of history — trend unlocks at 2+';
  }
  const avg = velocity?.rolling_avg_points;
  const stdev = velocity?.rolling_stdev_points;
  if (avg == null) {
    return `Last ${count} sprints`;
  }
  if (stdev != null && stdev > 0) {
    return `avg ${Math.round(avg)} ± ${Math.round(stdev)} / sprint`;
  }
  return `avg ${Math.round(avg)} / sprint`;
}
