/**
 * "Lower bound" caveat for a velocity-driven Monte Carlo P80/P95 (#4954).
 *
 * The server counts the runs where an open scrum task's velocity draw hit the sprint
 * horizon and was clamped (`velocity_saturated_runs`, #2469). Only a non-zero count
 * makes the upper percentiles lower bounds, so the note renders only then. `0` needs
 * no caveat, and `undefined` (the persisted-history fallback omits the field) is
 * unknown rather than zero — neither renders a claim.
 */
export function VelocitySaturationNote({
  saturatedRuns,
  runs,
}: {
  saturatedRuns: number | undefined;
  runs: number;
}) {
  if (saturatedRuns === undefined || saturatedRuns <= 0 || runs <= 0) return null;
  // Never print 0% for a non-zero count: a handful of clamped runs in a large sample
  // would round down and read as the all-clear.
  const pct = Math.max(1, Math.round((saturatedRuns / runs) * 100));
  return (
    <p
      className="mb-3 rounded-chip border border-neutral-border bg-neutral-surface-raised px-2 py-1 text-xs text-neutral-text-secondary"
      data-testid="velocity-saturation-note"
    >
      <strong className="font-medium text-neutral-text-primary">P80 and P95 are lower bounds.</strong>{' '}
      <span className="tppm-mono">{saturatedRuns.toLocaleString()}</span> of{' '}
      <span className="tppm-mono">{runs.toLocaleString()}</span> runs (
      <span className="tppm-mono">{pct}%</span>) reached the sprint horizon, so the true dates
      are this date or later.
    </p>
  );
}
