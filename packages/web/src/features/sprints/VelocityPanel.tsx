import type { ProjectVelocity } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  velocity: ProjectVelocity;
}

const BAR_W = 32;
const BAR_GAP = 6;
const CHART_H = 80;
// Extra vertical room below the bars for the "excl" sub-label on excluded
// sprints (ADR-0113). The number sits at CHART_H + 12; "excl" at CHART_H + 26.
const LABEL_H = 30;

/**
 * Velocity panel — last-N closed sprints as bars, rolling avg ± stdev, and a
 * forecast range chip. Bar colour is a coarse signal: green on completion ≥ 0.85,
 * amber on 0.6–0.85, red below. ADR-0036 footer note references the CPM feed.
 */
export function VelocityPanel({ velocity }: Props) {
  const itl = useIterationLabel();
  const sprints = velocity.sprints;
  const max = Math.max(
    1,
    ...sprints.flatMap((s) => [s.committed_points ?? 0, s.completed_points ?? 0]),
  );
  const stdev = velocity.rolling_stdev_points;
  const avg = velocity.rolling_avg_points;
  const low = velocity.forecast_range_low;
  const high = velocity.forecast_range_high;
  const excludedCount = velocity.excluded_count;
  // Sprints that actually feed the average/band = displayed minus excluded.
  const countedCount = sprints.length - excludedCount;
  const excludedNames = sprints
    .filter((s) => s.exclude_from_velocity)
    .map((s) => s.name)
    .join(', ');
  const chartW = sprints.length * (BAR_W + BAR_GAP) + BAR_GAP;
  // Rolling-average reference line height. Guarded `avg <= max` so the line
  // always sits inside the plot area (avg is a mean of completed points, so it
  // can never exceed the chart's `max`, but the guard keeps the math safe).
  const avgY = avg !== null && avg <= max ? CHART_H - (avg / max) * CHART_H : null;

  return (
    <section
      aria-labelledby="velocity-panel-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2
          id="velocity-panel-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Velocity
        </h2>
        <div className="flex items-baseline gap-2">
          {excludedCount > 0 && (
            <span
              className="tppm-mono text-xs px-2 py-0.5 rounded border border-dashed border-neutral-border bg-transparent text-neutral-text-secondary"
              title={`${excludedNames} excluded from this forecast — shown for history but not counted in the velocity average or band.`}
              aria-label={`${excludedCount} sprint${excludedCount === 1 ? '' : 's'} excluded from this forecast: ${excludedNames}`}
            >
              ⌀ {excludedCount} excluded
            </span>
          )}
          {low !== null && high !== null && (
            <span
              className="tppm-mono text-xs px-2 py-0.5 rounded border border-neutral-border bg-transparent text-neutral-text-secondary"
              aria-label={`Forecast range ${low} to ${high} points`}
            >
              Forecast {low}–{high} pts
            </span>
          )}
        </div>
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
              <span className="ml-1">(last {countedCount})</span>
            </span>
          </>
        ) : (
          <span className="italic text-neutral-text-disabled">
            No closed {itl.lowerPlural} yet
          </span>
        )}
      </p>

      {sprints.length > 0 && (
        <svg
          viewBox={`0 0 ${chartW} ${CHART_H + LABEL_H}`}
          className="w-full h-auto"
          role="img"
          aria-label="Velocity bar chart"
          aria-describedby="velocity-band-legend"
        >
          <defs>
            {/* Diagonal hatch marks an excluded sprint without relying on colour
                (WCAG 1.4.1) — survives greyscale and colour-blind palettes. */}
            <pattern
              id="velocity-excluded-hatch"
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width={6} height={6} className="fill-neutral-surface-sunken" />
              <line x1={0} y1={0} x2={0} y2={6} className="stroke-neutral-text-disabled" strokeWidth={1.5} />
            </pattern>
          </defs>
          {sprints.map((s, i) => {
            const completed = s.completed_points ?? 0;
            const committed = s.committed_points ?? 0;
            const ratio = committed > 0 ? completed / committed : 0;
            const excluded = s.exclude_from_velocity;
            // Health band: same thresholds drive the bar fill colour and the
            // non-color <title> signal so screen-reader users get the same
            // classification as sighted users (WCAG 1.4.1). Excluded sprints
            // (ADR-0113) opt out of the health palette entirely — they read as
            // muted + hatched so they cannot be mistaken for a counted bar.
            const { cls, band } = excluded
              ? { cls: '', band: 'excluded from velocity' }
              : ratio >= 0.85
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
                  fill={excluded ? 'url(#velocity-excluded-hatch)' : undefined}
                  rx={2}
                >
                  <title>
                    {excluded
                      ? `${s.name}: ${completed} pts — excluded from velocity`
                      : `${s.name}: ${completed}/${committed} pts (${band})`}
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
                {excluded && (
                  <text
                    x={x + BAR_W / 2}
                    y={CHART_H + 26}
                    textAnchor="middle"
                    className="text-xs fill-neutral-text-disabled italic"
                  >
                    excl
                  </text>
                )}
              </g>
            );
          })}
          {avgY !== null && (
            // Rolling-average trendline drawn ON TOP of the bars. Neutral ink
            // (`neutral-text-primary`, navy) — never a semantic hue — so it stays
            // distinct from the green/amber/red health bars and reverses in dark
            // mode (rules 147/163). Decorative (`aria-hidden`): the numeric value
            // is already in the `{avg} ± {stdev} pts` text and the sr-only legend.
            <g aria-hidden="true" data-testid="velocity-avg-line">
              <line
                x1={0}
                y1={avgY}
                x2={chartW}
                y2={avgY}
                className="stroke-neutral-text-primary"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <text
                x={chartW - 2}
                y={Math.max(avgY - 3, 9)}
                textAnchor="end"
                className="text-xs fill-neutral-text-secondary"
              >
                avg
              </text>
            </g>
          )}
        </svg>
      )}

      <p id="velocity-band-legend" className="sr-only">
        Bar colour indicates sprint health: on track is 85 percent or more of
        committed points completed, at risk is 60 to 85 percent, below target is
        under 60 percent. Sprints marked excluded are held out of the velocity
        average and forecast.
        {avgY !== null && ' A dashed horizontal line marks the rolling average.'}
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
