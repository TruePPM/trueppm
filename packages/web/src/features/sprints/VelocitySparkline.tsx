import { useMemo } from 'react';
import type { ProjectVelocity, VelocitySprintEntry } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { IterationLabelForms } from '@/lib/iterationLabel';

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
 * Inline velocity trend sparkline for the Board SprintPanel (ADR-0073, #607).
 * Renders up to 8 closed sprints as vertical bars, scaled to the maximum
 * completed_points value, behind a shaded **min–max band** with a dashed
 * **P50 (median) line** so the at-a-glance read is "where throughput usually
 * lands" — Alex's "see the velocity trend without exporting a spreadsheet" ask.
 * The most recent bar uses brand-primary for focus; the others a muted variant.
 *
 * Empty states:
 * - velocity loading → skeleton block
 * - 0 closed sprints → "No closed sprints" copy
 * - 1 sprint → single centered bar with caption (band needs 2+)
 * - 2–8 sprints → full sparkline with band + median line
 *
 * SVG carries an accessible aria-label with the underlying numeric series plus
 * the min / median / max so screen-reader users get the band data too.
 */
export function VelocitySparkline({ velocity, isLoading = false }: Props) {
  const itl = useIterationLabel();
  const sprints = useMemo(() => {
    if (!velocity) return [];
    return velocity.sprints.filter((s) => s.completed_points !== null).slice(-MAX_BARS);
  }, [velocity]);

  // Min / median (P50) / max of the completed-points series — the band overlay.
  // Excluded sprints (ADR-0113) are held out of the band/median; they still
  // render as hollow bars so the trend the team sees matches the velocity stats.
  const band = useMemo(() => bandStats(sprints.filter((s) => !s.exclude_from_velocity)), [sprints]);

  if (isLoading) {
    return (
      <div
        className="h-6 w-16 rounded-chip bg-neutral-surface-sunken"
        role="status"
        aria-label="Loading velocity"
      />
    );
  }

  if (sprints.length === 0) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs text-neutral-text-secondary">No closed {itl.lowerPlural}</p>
        <p className="text-xs text-neutral-text-secondary">
          Velocity unlocks after the first {itl.lower} closes
        </p>
      </div>
    );
  }

  const latest = sprints[sprints.length - 1];
  const latestPoints = latest?.completed_points ?? 0;
  const max = Math.max(...sprints.map((s) => s.completed_points ?? 0), 1);
  // Count of sprints held out of the velocity average (ADR-0113). The SVG
  // aria-label already announces this for screen readers; the pill is the
  // *visible* signal for sighted users that the average is over a reduced set.
  const excluded = sprints.filter((s) => s.exclude_from_velocity).length;

  return (
    <div className="space-y-0.5" data-testid="velocity-sparkline">
      <div className="flex items-center gap-2">
        <svg
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={buildAriaLabel(sprints, velocity, band, itl)}
        >
          {/* Min–max band + P50 line behind the bars. Needs 2+ sprints and a
              non-degenerate range (min !== max) to be meaningful. */}
          {band && band.max > band.min && (
            <>
              <rect
                x={0}
                y={yFor(band.max, max)}
                width={WIDTH}
                height={Math.max(1, yFor(band.min, max) - yFor(band.max, max))}
                className="fill-brand-primary"
                opacity={0.12}
              />
              <line
                x1={0}
                x2={WIDTH}
                y1={yFor(band.median, max)}
                y2={yFor(band.median, max)}
                className="stroke-brand-primary"
                strokeWidth={1}
                strokeDasharray="2 2"
                opacity={0.7}
              />
            </>
          )}
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
        {excluded > 0 && (
          <span
            className="text-xs text-neutral-text-secondary"
            title="Excluded from velocity average"
            aria-hidden="true"
          >
            <span className="tppm-mono">{excluded}</span> excluded
          </span>
        )}
      </div>
      <p className="text-xs text-neutral-text-secondary">
        {sprintsCaption(sprints.length, velocity, itl)}
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
  // Excluded sprints (ADR-0113) render hollow — outline only, no fill — so they
  // read as "present but not counted" at 64px where a hatch pattern won't fit.
  // Shape (hollow vs solid) carries the signal, not colour alone (WCAG 1.4.1).
  if (sprint.exclude_from_velocity) {
    return (
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={BAR_W - 1}
        height={Math.max(1, h - 1)}
        rx={1}
        fill="none"
        className="stroke-neutral-text-disabled"
        strokeWidth={1}
        strokeDasharray="2 1.5"
      />
    );
  }
  const fill = isLatest ? 'fill-brand-primary' : 'fill-brand-primary-dark';
  const opacity = isLatest ? 1 : 0.55;
  return <rect x={x} y={y} width={BAR_W} height={h} rx={1} className={fill} opacity={opacity} />;
}

interface BandStats {
  min: number;
  median: number;
  max: number;
}

/** Min / median (P50) / max of the completed-points series; null for <2 sprints. */
function bandStats(sprints: VelocitySprintEntry[]): BandStats | null {
  const values = sprints.map((s) => s.completed_points ?? 0);
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

/** Map a points value to a y pixel, scaled to the chart's max (0 = top). */
function yFor(value: number, max: number): number {
  return HEIGHT - (value / max) * HEIGHT;
}

function buildAriaLabel(
  sprints: VelocitySprintEntry[],
  velocity: ProjectVelocity | undefined,
  band: BandStats | null,
  itl: IterationLabelForms,
): string {
  const values = sprints.map((s) => s.completed_points ?? 0);
  const latest = values[values.length - 1] ?? 0;
  const avg = velocity?.rolling_avg_points;
  const avgPart = avg != null ? `; rolling average ${Math.round(avg)} points` : '';
  const bandPart =
    band && band.max > band.min
      ? `; range ${band.min}–${band.max} points, median ${Math.round(band.median)}`
      : '';
  const excluded = sprints.filter((s) => s.exclude_from_velocity).length;
  const excludedPart = excluded > 0 ? `; ${excluded} excluded from velocity` : '';
  return `Velocity over last ${sprints.length} ${
    sprints.length === 1 ? itl.lower : itl.lowerPlural
  }: ${values.join(', ')} points; latest ${latest} points${avgPart}${bandPart}${excludedPart}.`;
}

function sprintsCaption(
  count: number,
  velocity: ProjectVelocity | undefined,
  itl: IterationLabelForms,
): string {
  if (count === 1) {
    return `1 ${itl.lower} of history — trend unlocks at 2+`;
  }
  const avg = velocity?.rolling_avg_points;
  const stdev = velocity?.rolling_stdev_points;
  if (avg == null) {
    return `Last ${count} ${itl.lowerPlural}`;
  }
  if (stdev != null && stdev > 0) {
    return `avg ${Math.round(avg)} ± ${Math.round(stdev)} / ${itl.lower}`;
  }
  return `avg ${Math.round(avg)} / ${itl.lower}`;
}
