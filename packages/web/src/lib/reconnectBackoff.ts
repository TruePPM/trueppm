/**
 * Full-jitter delay for a reconnect attempt.
 *
 * Returns a uniformly random delay in `[0, windowMs)`, where `windowMs` is the
 * already-capped exponential window (`min(cap, base * 2^n)`). Deterministic
 * 1s/2s/4s backoff makes every client that lost the same server (a deploy, a
 * proxy restart) reconnect in lock-step, so the recovering server meets the
 * whole fleet at once on each step. Randomizing across the whole window spreads
 * the herd while keeping the exponential ceiling.
 *
 * @param windowMs - Upper bound of the delay window in milliseconds.
 * @returns Delay in whole milliseconds, `0 <= delay < windowMs`.
 */
export function fullJitterDelay(windowMs: number): number {
  return Math.floor(Math.random() * windowMs);
}
