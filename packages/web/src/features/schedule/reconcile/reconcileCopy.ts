/**
 * Every user-visible string the reconciliation surfaces produce (ADR-0784, #2725).
 *
 * Centralized because the same sentence has to appear in three places that a
 * planner reads as one claim — the cell's `aria-label`, the strip's review list,
 * and the polite announcement — and three copies of it would drift.
 *
 * The load-bearing rule here is §D5: **we state the fact and never invent a
 * cause.** The client cannot know why the engine moved a date. `EffectiveCalendar`
 * carries `working_days` (a weekly bitmask) and `holiday_count` — *a count*, not
 * the exception dates — and the `task_dates_updated` delta carries no reason. A
 * planner told "the July shutdown week" who then finds no shutdown configured
 * will stop trusting every other marker on the screen, so the only qualifier we
 * add is the one the weekly mask can actually prove.
 */

import { fmtUtcShort, fmtUtcLong } from '@/lib/formatUtcDate';
import type { ReconcileEntry, ReconcileField } from './reconcileState';

/** Mon–Fri (1+2+4+8+16) — the server's `working_day_duration` default. */
export const MON_FRI_MASK = 31;

/**
 * Is a UTC-midnight ISO date a working day under a `Calendar.working_days` mask?
 *
 * `bit = 1 << pythonWeekday` (Mon=1 … Sun=64), identical to the server's
 * convention. Reads `getUTCDay()`, never `getDay()`: every date in this feature
 * is a UTC-midnight instant, and a viewer-local read shifts the weekday by one
 * for anyone behind UTC — silently mis-classifying Friday as Saturday in a way
 * CI cannot catch, because the runner sits on UTC (rule 56).
 */
export function isWorkingDay(iso: string, mask: number): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sun … 6 = Sat
  const bit = 1 << (dow === 0 ? 6 : dow - 1);
  return (mask & bit) !== 0;
}

const FIELD_NOUN: Record<ReconcileField, string> = { start: 'Start', finish: 'Finish' };

/**
 * Format a date for a Schedule outline cell.
 *
 * `fmtUtcShort` returns its raw input when the string is unparseable; the
 * outline collapses that to an em dash instead, so a malformed date reads as
 * "no date" rather than leaking an ISO string into a 74px column. Moved here
 * from `TaskListRow`'s local `formatDate` when the reconciliation marker took
 * over cell rendering — keeping two copies would let the marker and the plain
 * value disagree about what an unparseable date looks like.
 */
export function fmtCellDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const formatted = fmtUtcShort(iso);
  return formatted === iso ? '—' : formatted;
}

/**
 * The qualifier explaining a move — ONLY where the weekly mask proves it.
 *
 * Returns null when the old date *was* a working day: the move then came from
 * something the client cannot see (a holiday row, a dependency cascade, a
 * constraint), and saying nothing is the honest output (§D5).
 */
export function deriveCause(entry: ReconcileEntry, workingDaysMask: number): string | null {
  if (!entry.actual) return null;
  if (isWorkingDay(entry.expected, workingDaysMask)) return null;
  return `${fmtCellDate(entry.expected)} is not a working day`;
}

/**
 * One divergence as a sentence: "Finish moved Oct 13 → Oct 16" plus the
 * mask-provable qualifier when there is one.
 */
export function describeDivergence(entry: ReconcileEntry, workingDaysMask: number): string {
  const base = `${FIELD_NOUN[entry.field]} moved ${fmtCellDate(entry.expected)} → ${fmtCellDate(entry.actual)}`;
  const cause = deriveCause(entry, workingDaysMask);
  return cause ? `${base}: ${cause}` : base;
}

/**
 * The gridcell's accessible name.
 *
 * Screen-reader users get the whole claim here because the visible cell is only
 * ~74px wide and cannot carry it (§D7 / the column defaults). Note the label is
 * the ONLY place the pending and reviewed states are distinguishable without
 * sight — italic is a purely visual signal.
 */
export function cellAriaLabel(
  field: ReconcileField,
  value: string | null | undefined,
  entry: ReconcileEntry | undefined,
): string {
  const verb = field === 'start' ? 'starts' : 'finishes';
  if (!value) return 'unscheduled';
  if (!entry) return `${verb} ${fmtCellDate(value)}`;
  if (entry.status === 'preview') return `${verb} ${fmtCellDate(value)}, pending confirmation`;
  if (entry.status === 'rejected') {
    return `${verb} ${fmtCellDate(value)}, change refused: ${entry.reason ?? 'no reason given'}`;
  }
  const move = `${field} moved from ${fmtCellDate(entry.expected)} to ${fmtCellDate(entry.actual)}`;
  if (entry.status === 'cascade') {
    // The ONLY channel that separates a cascade from a divergence without sight
    // — the two differ visually by colour alone (see `DateCellValue`). "not your
    // edit" is the whole point: it tells the listener there is nothing of theirs
    // to re-check here, which "not yet reviewed" would imply the opposite of.
    return `${move}, a knock-on change — not your edit`;
  }
  return `${move}, not yet reviewed`;
}

/**
 * The polite announcement. Rendered into an always-mounted `role="status"`
 * region — a live region that mounts at the same moment its text appears is not
 * reliably announced (§D7).
 *
 * Empty string when there is nothing to say, which clears the region rather than
 * leaving a stale count to be re-read.
 */
/**
 * @param movedCount Every date that moved — the planner's own unconfirmed writes
 *   AND the cascades onto rows they never touched (#3041). A count that excluded
 *   the cascade rows would announce "1 date changed" for a run that moved twelve,
 *   which is worse than silence: it states a number that is wrong rather than
 *   leaving the listener to ask.
 */
export function announcement(movedCount: number, projectFinishIso: string | null): string {
  if (movedCount === 0) return '';
  const dates = movedCount === 1 ? '1 date changed' : `${movedCount} dates changed`;
  const finish = projectFinishIso ? ` Project finish now ${fmtUtcLong(projectFinishIso)}.` : '';
  return `Schedule recomputed. ${dates}.${finish}`;
}

/** Strip count label — "3 dates changed". */
export function changedCountLabel(count: number): string {
  return count === 1 ? '1 date changed' : `${count} dates changed`;
}
