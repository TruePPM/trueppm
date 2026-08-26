/**
 * Duration units for entry and display (#2975, epic #2946).
 *
 * `Task.duration` is, and stays, an **integer count of working days**. The
 * scheduling engine is integer-days end to end (`_effective_duration_days() -> int`),
 * and that truncation is part of the Python/Rust conformance contract (ADR-0132).
 * MS Project export and the `TaskDurationChange` audit read the same field.
 *
 * So a unit here changes **what the user types and reads**, never what is stored
 * or scheduled. Hours convert through the project calendar's `hours_per_day` and
 * round to whole days.
 *
 * The one rule that makes this honest: **the rounding is always stated.** A
 * planner who types `20h` and silently gets 3 days has been lied to, and will
 * stop trusting every other number on the screen. `describeEntry()` exists so no
 * caller can forget to say it.
 */

export type DurationUnit = 'days' | 'hours';

/** Fallback when a project's calendar has not loaded — matches `Calendar.hours_per_day`. */
export const DEFAULT_HOURS_PER_DAY = 8;

export interface DurationEntry {
  /** What gets written to `Task.duration` — always whole working days. */
  days: number;
  /** True when the entered value did not land on a whole day. */
  rounded: boolean;
  /** The exact, unrounded day equivalent — for explaining the rounding. */
  exactDays: number;
}

/**
 * The one rate resolver. Exported so the authoring-token lexer shares it (#3042)
 * rather than carrying a second `> 0` guard that can drift from this one.
 *
 * A zero or negative hours-per-day would make every hours entry infinite or
 * negative. The calendar validator should prevent it; this is the belt.
 */
export function safeHoursPerDay(hoursPerDay: number | null | undefined): number {
  return hoursPerDay != null && hoursPerDay > 0 ? hoursPerDay : DEFAULT_HOURS_PER_DAY;
}

/**
 * Convert a value the user typed, in `unit`, into the stored working-day count.
 *
 * Rounds **up** on a tie and on any fraction: a task estimated at 20h does not
 * fit in 2 days, and rounding down would silently under-plan it. Under-planning
 * is the more expensive error on a schedule, so the rounding is deliberately
 * asymmetric rather than nearest-even.
 */
export function toStoredDays(
  value: number,
  unit: DurationUnit,
  hoursPerDay: number | null | undefined,
): DurationEntry {
  if (unit === 'days') {
    const days = Math.max(0, Math.round(value));
    return { days, rounded: days !== value, exactDays: value };
  }
  const exactDays = value / safeHoursPerDay(hoursPerDay);
  const days = Math.max(0, Math.ceil(exactDays));
  return { days, rounded: days !== exactDays, exactDays };
}

/** Render a stored working-day count back in the task's own unit. */
export function fromStoredDays(
  days: number,
  unit: DurationUnit,
  hoursPerDay: number | null | undefined,
): number {
  return unit === 'days' ? days : days * safeHoursPerDay(hoursPerDay);
}

/** `3d` / `24h` — the label for a duration cell or chip. No space, matching the
 * shipped convention everywhere else in the schedule. */
export function formatDuration(
  days: number,
  unit: DurationUnit,
  hoursPerDay: number | null | undefined,
): string {
  const value = fromStoredDays(days, unit, hoursPerDay);
  // Hours can land on a fraction when hours_per_day is fractional (7.5 is
  // common). One decimal, trimmed — "7.5 h", never "7.5000000001 h".
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
  return `${shown}${unit === 'days' ? 'd' : 'h'}`;
}

/**
 * The sentence shown under the field after an entry — `null` when nothing was
 * rounded and there is therefore nothing to explain.
 *
 * Says what was stored **and why**, because "rounded to 3" without the reason
 * reads as a bug rather than a constraint.
 */
export function describeEntry(entry: DurationEntry, unit: DurationUnit): string | null {
  if (!entry.rounded) return null;
  if (unit === 'days') {
    return `Stored as ${entry.days} d — durations are whole working days.`;
  }
  // `toFixed(2)` always yields exactly two decimals, so the only trailing-zero
  // shapes are `.00` (drop the point too) and a single `0`. Enumerating them
  // avoids the unbounded `0+$` quantifier, which backtracks (Sonar S8786).
  const exact = entry.exactDays.toFixed(2).replace(/\.00$|0$/, '');
  const dayWord = entry.days === 1 ? 'day' : 'days';
  return `That is ${exact} days — stored as ${entry.days} ${dayWord}, because the schedule engine works in whole days.`;
}

/**
 * The duration spelled out for an accessible name — "12 days", "24 hours".
 *
 * Distinct from {@link formatDuration}, which abbreviates for a dense cell. A
 * screen reader given "12d" says "twelve dee", so the visible abbreviation must
 * never become the accessible name.
 */
export function spellDuration(
  days: number,
  unit: DurationUnit,
  hoursPerDay: number | null | undefined,
): string {
  const value = fromStoredDays(days, unit, hoursPerDay);
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
  const noun = unit === 'days' ? 'day' : 'hour';
  return `${shown} ${value === 1 ? noun : `${noun}s`}`;
}
