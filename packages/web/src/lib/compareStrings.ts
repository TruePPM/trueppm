/**
 * String comparator for a **canonical** ordering (#2456).
 *
 * `sort()` with no argument already compares UTF-16 code units, which is exactly
 * what a canonical ordering wants — but it reads as an oversight, so SonarCloud
 * flags every bare `sort()` on a string array and suggests `localeCompare`. That
 * suggestion is right for a list a person reads and wrong for everything else,
 * so the choice has to be stated rather than defaulted into.
 *
 * Use {@link compareCodeUnits} whenever the order feeds a machine: a cache or
 * storage key, a query-parameter value, a set canonicalized before hashing,
 * ISO-8601 dates (whose lexical order *is* their chronological order). Collation
 * is locale-sensitive and ICU-version-dependent — `-` is treated as variable and
 * the primary strength is case-insensitive — so `localeCompare` may order the
 * same inputs differently after a locale change or a browser update. A key built
 * that way silently stops matching the one already persisted.
 *
 * For a list rendered to a user, do the opposite and call `a.localeCompare(b)`
 * directly: "ä sorts next to a" is what a reader expects and no key depends on
 * it. The question to ask is who consumes the order — a machine, or a person.
 */

/** Deterministic UTF-16 code-unit order — stable across engines and locales. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
