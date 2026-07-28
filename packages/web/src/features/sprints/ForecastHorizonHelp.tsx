import { FieldHelp } from '@/components/FieldHelp';

/** Which bootstrap input the forecast under this affordance was sampled from. */
export type ForecastHorizonBasis = 'velocity' | 'throughput';

/**
 * Contextual-help affordance stating that a `/sprint-forecast/` percentile is a
 * **floor**, not an unbiased percentile.
 *
 * Why this exists (#2495): both bootstrap samplers bound each run's horizon —
 * `_sample_backlog_sprint_counts` at `ceil(remaining / mean) * 4 + 10` sprints,
 * and the weekly throughput sampler identically at `max_weeks`. A run that has
 * not burned down by that horizon is *assigned* the horizon rather than sampled
 * further (`np.where(reached.any(...), argmax + 1, max_sprints)`), which truncates
 * the slow right tail. The estimator fix is #2469 (0.6); until then the product
 * showed bare "P80" / "P95" with a "Monte Carlo over velocity" claim beside it and
 * the caveat lived only on the public Known Issues page. A PM screenshotting the
 * widget for a steering deck had no way to learn the number was optimistic.
 *
 * This is the sibling of `schedule/ForecastBasisHelp` (#2439), which answers "what
 * *is* this date" for the CPM/PERT path. This one answers "how far can you trust
 * it" for the agile path. Kept as its own component for the same reason #2439 was:
 * three surfaces render this number (the project-overview widget, the sprint-panel
 * chips, the board's flow card), so the second and third mount points are an import
 * rather than a paste and the three can never drift into three different stories
 * about the same figure.
 *
 * `FieldHelp` rather than `Tooltip` is forced by rule 287(b) — the content carries
 * a docs link, and an `aria-describedby` tooltip's link is unreachable (rule 121).
 */
export function ForecastHorizonHelp({ basis }: { basis: ForecastHorizonBasis }) {
  const velocity = basis === 'velocity';
  const unit = velocity ? 'sprint' : 'week';
  const source = velocity ? "your team's closed-sprint velocity" : 'your recent weekly throughput';
  return (
    <FieldHelp
      // Lowercase deliberately: the popover heading renders `uppercase` via CSS, so
      // the display text is unaffected, while the trigger's generated accessible
      // name ("About the forecast horizon options") stays readable — sentence case
      // here produces "About the Forecast horizon options" for screen-reader users.
      label="forecast horizon"
      docHref="features/monte-carlo/#velocity-and-throughput-forecasts-are-a-floor"
      docLabel="Why this is a floor"
      body={
        <div className="flex flex-col gap-2">
          <p>
            This range is simulated from {source} — each run re-samples past{' '}
            {velocity ? 'sprints' : 'weeks'} and counts how many it takes to clear the
            remaining backlog.
          </p>
          <p>
            Every run stops at a fixed {unit} horizon. Runs that have not finished by then
            are counted as finishing <em>at</em> the horizon rather than sampled further, so
            the slowest outcomes are cut off.
          </p>
          <p className="text-xs text-neutral-text-secondary">
            That makes the upper percentiles a <strong className="text-neutral-text-primary">floor</strong>:
            the true P80 and P95 are this date or later, never earlier. The gap widens the
            more {velocity ? 'your velocity varies sprint to sprint' : 'your weekly throughput varies'}.
          </p>
          <p className="text-xs text-neutral-text-secondary">
            For a date you have to commit to externally, estimate that work with three-point
            (PERT) durations instead — the PERT path is not clamped.
          </p>
        </div>
      }
    />
  );
}
