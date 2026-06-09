import type { ProjectVelocity } from '@/hooks/useSprints';

interface Props {
  velocity: ProjectVelocity;
}

const BAR_W = 32;
const BAR_GAP = 6;
const CHART_H = 80;

/**
 * Velocity panel — last-N closed sprints as bars, rolling avg ± stdev, and a
 * forecast range chip. Bar colour is a coarse signal: green on completion ≥ 0.85,
 * amber on 0.6–0.85, red below. ADR-0036 footer note references the CPM feed.
 */
export function VelocityPanel({ velocity }: Props) {
  const sprints = velocity.sprints;
  const max = Math.max(
    1,
    ...sprints.flatMap((s) => [s.committed_points ?? 0, s.completed_points ?? 0]),
  );
  const stdev = velocity.rolling_stdev_points;
  const avg = velocity.rolling_avg_points;
  const low = velocity.forecast_range_low;
  const high = velocity.forecast_range_high;
  const chartW = sprints.length * (BAR_W + BAR_GAP) + BAR_GAP;

  return (
    <section
      aria-labelledby="velocity-panel-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="velocity-panel-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Velocity
        </h2>
        {low !== null && high !== null && (
          <span
            className="tppm-mono text-xs px-2 py-0.5 rounded border border-neutral-border bg-transparent text-neutral-text-secondary"
            aria-label={`Forecast range ${low} to ${high} points`}
          >
            Forecast {low}–{high} pts
          </span>
        )}
      </div>

      <p className="text-sm font-medium text-neutral-text-primary">
        {avg !== null ? (
          <>
            <span className="tppm-mono">{avg}</span>
            {stdev !== null && (
              <>
                {' '}
                <span className="text-neutral-text-secondary">±</span>{' '}
                <span className="tppm-mono">{stdev}</span>
              </>
            )}
            <span className="text-xs text-neutral-text-secondary">
              {' '}pts
              <span className="ml-1">(last {sprints.length})</span>
            </span>
          </>
        ) : (
          <span className="italic text-neutral-text-disabled">
            No closed sprints yet
          </span>
        )}
      </p>

      {sprints.length > 0 && (
        <svg
          viewBox={`0 0 ${chartW} ${CHART_H + 16}`}
          className="w-full h-auto"
          role="img"
          aria-label="Velocity bar chart"
          aria-describedby="velocity-band-legend"
        >
          {sprints.map((s, i) => {
            const completed = s.completed_points ?? 0;
            const committed = s.committed_points ?? 0;
            const ratio = committed > 0 ? completed / committed : 0;
            // Health band: same thresholds drive the bar fill colour and the
            // non-color <title> signal so screen-reader users get the same
            // classification as sighted users (WCAG 1.4.1).
            const { cls, band } =
              ratio >= 0.85
                ? { cls: 'fill-semantic-on-track', band: 'on track' }
                : ratio >= 0.6
                  ? { cls: 'fill-semantic-at-risk', band: 'at risk' }
                  : { cls: 'fill-semantic-critical', band: 'below target' };
            const h = (completed / max) * CHART_H;
            const x = BAR_GAP + i * (BAR_W + BAR_GAP);
            return (
              <g key={s.id}>
                <rect
                  x={x}
                  y={CHART_H - h}
                  width={BAR_W}
                  height={h}
                  className={cls}
                  rx={2}
                >
                  <title>
                    {s.name}: {completed}/{committed} pts ({band})
                  </title>
                </rect>
                <text
                  x={x + BAR_W / 2}
                  y={CHART_H + 12}
                  textAnchor="middle"
                  className="tppm-mono text-xs fill-neutral-text-disabled"
                >
                  {completed}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      <p id="velocity-band-legend" className="sr-only">
        Bar colour indicates sprint health: on track is 85 percent or more of
        committed points completed, at risk is 60 to 85 percent, below target is
        under 60 percent.
      </p>

      <p className="text-xs text-neutral-text-secondary italic">
        Velocity feeds CPM duration estimates ·{' '}
        <a
          href="https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0036-hybrid-pm-philosophy-and-sprint-model.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
        >
          ADR-0036
        </a>
      </p>
    </section>
  );
}
