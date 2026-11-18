/**
 * Mount gate behind `ForecastHorizonHelp` (#2495, #2653).
 *
 * `ForecastHorizonHelp`'s mount list used to be entirely hand-maintained, with
 * nothing tying "renders a clamped-sampler forecast" to "carries the floor
 * caveat" — #2643 and #2653 each independently found a site that had drifted off
 * the list. This module is the pure predicate behind that gate, factored out of
 * `ForecastHorizonHelp.test.tsx` so it can be exercised against a synthetic
 * violation (proving it actually fires) as well as against the real source tree.
 *
 * The signal is deliberately narrow: a source file that calls `useSprintForecast(`
 * — the hook backed by `GET /projects/{id}/sprint-forecast/`, whose velocity and
 * throughput readings both come from a clamped-horizon bootstrap sampler
 * (`_sample_backlog_sprint_counts` and the weekly throughput sampler; see #2469)
 * — must also mount `<ForecastHorizonHelp` somewhere in the same file.
 *
 * This is narrower than "renders any velocity/throughput-flavored number" on
 * purpose. `useProjectForecast`'s `sprints_to_complete_low/high` (consumed by
 * `VelocityForecastLine` and `MilestoneBridgeForecast`) is a *different*,
 * unclamped computation — `_sprints_to_complete` is a plain avg±1σ division with
 * no resampling and no horizon — and does not carry the bias this component
 * exists to caveat. Flagging those sites would force a mount whose copy
 * ("each run re-samples past sprints...", "stops at a fixed sprint horizon")
 * misdescribes the mechanism; see the #2653 scope-boundary tests in
 * `VelocityForecastLine.test.tsx` and `MilestoneBridgeForecast.test.tsx`.
 */
export function findMissingForecastHorizonMounts(files: Record<string, string>): string[] {
  const offenders: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    // ForecastHorizonHelp's own module/spec necessarily contain the identifier
    // without "mounting" it in the gated sense; test files are covered by the
    // components they test, not by this source-level scan.
    if (path.includes('ForecastHorizonHelp')) continue;
    if (path.includes('.test.')) continue;
    if (!/\buseSprintForecast\(/.test(source)) continue;
    if (!/<ForecastHorizonHelp\b/.test(source)) {
      offenders.push(path);
    }
  }
  return offenders;
}
