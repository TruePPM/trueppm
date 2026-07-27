/**
 * Plain-English reading of a Monte Carlo percentile label (#2389).
 *
 * `P80` is domain shorthand that a first-time self-hoster cannot decode, and it
 * appears on at least four surfaces (the schedule forecast bar, the TopBar
 * forecast pill, the detail panel, the mobile card). Centralizing the sentence
 * keeps those surfaces from drifting into four slightly different explanations
 * of the same number — the failure mode that made "P80" feel like four different
 * metrics rather than one.
 *
 * Phrased as "runs finish on or before" rather than "confidence": the figure is
 * a percentile of the simulated distribution, not a probability the plan is
 * correct, and the roadmap's "computed, not guessed" claim depends on us not
 * blurring the two.
 */
export function percentileExplanation(percentile: 50 | 80 | 95): string {
  return `${percentile}% of simulated runs finish on or before this date`;
}
