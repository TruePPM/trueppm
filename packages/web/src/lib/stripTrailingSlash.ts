/**
 * Trailing-slash normalization for issuer / host inputs (#2519).
 *
 * Deliberately not a regex. `/\/+$/` is the obvious spelling and it backtracks
 * super-linearly: on an input whose trailing slashes are *not* at the very end
 * (`"///x"`), the engine retries the greedy `\/+` from every start position and
 * gives up one character at a time, which is O(n²) (SonarCloud S8786). Inputs
 * here are operator-typed issuer URLs, so that is a correctness/hygiene concern
 * rather than an exploitable one — but a single reverse scan is both linear and
 * easier to read than the pattern it replaces.
 *
 * The scan compares one-character strings rather than code units. The original
 * spelling folded `'/'.charCodeAt(0)` into a constant and compared with
 * `s.charCodeAt(end - 1)`, which SonarCloud flags (S7758) — the project scopes
 * that rule out for the four code-unit *hash* loops, where `codePointAt` would
 * double-count an astral character and rehash the schedule-PDF integrity stamp,
 * and none of that reasoning reaches a single indexed comparison against ASCII
 * `/`. Indexing the string directly sidesteps the question rather than answering
 * it, and needs no surrogate argument to verify (#2566).
 */

/** Drop every trailing `/`. Returns the input unchanged when it has none. */
export function stripTrailingSlash(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return end === s.length ? s : s.slice(0, end);
}
