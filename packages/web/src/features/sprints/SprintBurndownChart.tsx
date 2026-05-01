import type { ApiSprint } from '@/types';
import type { SprintBurnSnapshot } from '@/hooks/useSprints';
import { daysBetween, sprintDayOf } from './sprintMath';

interface Props {
  sprint: ApiSprint;
  snapshots: SprintBurnSnapshot[];
  /** Override "today" for deterministic tests. */
  today?: Date;
}

const WIDTH = 520;
const HEIGHT = 220;
const PAD_LEFT = 36;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

interface Point {
  x: number;
  y: number;
  date: string;
  remaining: number;
  scopeDelta: number;
}

/**
 * Sprint burndown chart — Actual (solid), Ideal (dashed), Scope-add (dotted).
 *
 * Hand-rolled SVG (per ADR-0022 deferral of Recharts). Renders three series
 * over the sprint's working-day axis with a "today" marker and a trending
 * callout below. The ideal line is computed client-side from
 * ``sprint.committed_points``; the API does not return it.
 */
export function SprintBurndownChart({ sprint, snapshots, today = new Date() }: Props) {
  const totalDays = daysBetween(sprint.start_date, sprint.finish_date) + 1;
  const committed = sprint.committed_points ?? 0;
  const { day: dayIndex, total } = sprintDayOf(sprint.start_date, sprint.finish_date, today);

  // Build per-day points by joining snapshots to the sprint's date axis.
  const indexBy = new Map(snapshots.map((s) => [s.snapshot_date, s]));
  const days: Point[] = [];
  for (let i = 0; i < totalDays; i += 1) {
    const date = new Date(sprint.start_date + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + i);
    const iso = date.toISOString().slice(0, 10);
    const snap = indexBy.get(iso);
    days.push({
      x: i,
      y: snap?.remaining_points ?? committed,
      date: iso,
      remaining: snap?.remaining_points ?? committed,
      scopeDelta: snap?.scope_change_points ?? 0,
    });
  }

  const xMax = Math.max(totalDays - 1, 1);
  const yMax = Math.max(committed, ...days.map((p) => p.y), 1);
  const xScale = (x: number) => PAD_LEFT + (x / xMax) * (WIDTH - PAD_LEFT - PAD_RIGHT);
  const yScale = (y: number) =>
    PAD_TOP + (1 - y / yMax) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

  const actualPath = days
    .filter((p) => indexBy.has(p.date))
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.x)},${yScale(p.y)}`)
    .join(' ');

  const idealPath = `M${xScale(0)},${yScale(committed)} L${xScale(xMax)},${yScale(0)}`;

  const scopeChanges = days.filter((p) => p.scopeDelta !== 0);

  // Trending: compare actual remaining today to ideal remaining today.
  const idealNow = committed * (1 - dayIndex / total);
  const actualNow =
    days[Math.min(dayIndex - 1, days.length - 1)]?.remaining ?? committed;
  const ahead = idealNow - actualNow;
  const trendDirection = ahead >= 0 ? 'ahead' : 'behind';
  const trendColor =
    ahead >= 0 ? 'text-semantic-on-track' : 'text-semantic-at-risk';

  // Forecast: linear extrapolation from current pace to zero remaining.
  const remainingToday = actualNow;
  const burnRatePerDay =
    dayIndex > 0 ? (committed - actualNow) / dayIndex : 0;
  const forecastDaysFromNow =
    burnRatePerDay > 0 ? Math.ceil(remainingToday / burnRatePerDay) : null;
  const forecastDate =
    forecastDaysFromNow !== null
      ? offsetIso(today, forecastDaysFromNow)
      : null;

  const todayX = xScale(Math.min(dayIndex - 1, xMax));
  const workingDaysLeft = Math.max(0, total - dayIndex);

  return (
    <section
      aria-labelledby="sprint-burndown-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="sprint-burndown-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Sprint Burndown
        </h2>
        <p className="text-xs text-neutral-text-secondary">
          <span className="tppm-mono text-neutral-text-primary">
            {Math.max(0, Math.round(actualNow))} pts
          </span>{' '}
          remaining ·{' '}
          <span className="tppm-mono text-neutral-text-primary">{workingDaysLeft}</span>{' '}
          working days left
        </p>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
        role="img"
        aria-label="Sprint burndown chart"
      >
        {/* Y-axis baseline */}
        <line
          x1={PAD_LEFT}
          y1={HEIGHT - PAD_BOTTOM}
          x2={WIDTH - PAD_RIGHT}
          y2={HEIGHT - PAD_BOTTOM}
          stroke="currentColor"
          className="text-neutral-border"
        />
        {/* Y-axis labels */}
        <text
          x={PAD_LEFT - 6}
          y={yScale(yMax)}
          textAnchor="end"
          dominantBaseline="middle"
          className="tppm-mono text-[10px] fill-neutral-text-secondary"
        >
          {Math.round(yMax)}
        </text>
        <text
          x={PAD_LEFT - 6}
          y={yScale(0)}
          textAnchor="end"
          dominantBaseline="middle"
          className="tppm-mono text-[10px] fill-neutral-text-secondary"
        >
          0
        </text>

        {/* Ideal line — dashed */}
        <path
          d={idealPath}
          fill="none"
          strokeDasharray="4 4"
          stroke="currentColor"
          className="text-neutral-text-disabled"
          strokeWidth={1.5}
        />

        {/* Actual — solid */}
        {actualPath && (
          <path
            d={actualPath}
            fill="none"
            stroke="currentColor"
            className="text-brand-primary"
            strokeWidth={2}
          />
        )}

        {/* Scope-change markers — dotted amber points */}
        {scopeChanges.map((p) => (
          <circle
            key={p.date}
            cx={xScale(p.x)}
            cy={yScale(p.y)}
            r={3.5}
            fill="currentColor"
            className="text-semantic-at-risk"
            aria-label={`Scope change on ${p.date}: ${p.scopeDelta} pts`}
          />
        ))}

        {/* Today marker */}
        {dayIndex > 0 && dayIndex <= total && (
          <>
            <line
              x1={todayX}
              x2={todayX}
              y1={PAD_TOP}
              y2={HEIGHT - PAD_BOTTOM}
              stroke="currentColor"
              className="text-semantic-critical"
              strokeDasharray="3 3"
            />
            <text
              x={todayX}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="tppm-mono text-[10px] fill-semantic-critical font-medium"
            >
              TODAY
            </text>
          </>
        )}
      </svg>

      <p className={`text-xs ${trendColor}`}>
        Trending{' '}
        <span className="tppm-mono">
          {Math.abs(Math.round(ahead))}
        </span>
        {' '}pts {trendDirection} of ideal
        {scopeChanges.length > 0 && (
          <span className="text-neutral-text-secondary">
            {' · '}
            <span className="tppm-mono">
              scope-add {scopeChanges[0].date} (+{scopeChanges[0].scopeDelta} pts)
            </span>
          </span>
        )}
        {forecastDate && (
          <span className="float-right text-neutral-text-secondary">
            Forecast close: <span className="tppm-mono">{forecastDate}</span>
          </span>
        )}
      </p>
    </section>
  );
}

function offsetIso(base: Date, offsetDays: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
