/**
 * Recurrence domain types + the client-side "Next N occurrences" preview (ADR-0090, #738).
 *
 * The preview MUST mirror the server generator (apps/projects/services.py
 * `_occurrence_matches`) so the panel never shows dates the backend won't create:
 *   - DAILY / CUSTOM : every `interval` days from the anchor (CUSTOM is "every N days").
 *   - WEEKLY         : matching weekday bit, with the week aligned to the anchor's
 *                      Monday-week for interval > 1.
 *   - MONTHLY        : `day_of_month` (clamped to month length so 31 still fires in
 *                      February), every `interval` months from the anchor.
 *
 * Anchor parity: the server uses `template.planned_start || today`. The drawer
 * section doesn't carry the template's planned_start, so the preview anchors on
 * `today` — which is exactly the server's fallback when planned_start is null, and
 * the anchor is immaterial for the common `interval === 1` case (the matcher only
 * uses it to align the "every N" multiplier). For interval > 1 on a template that
 * has a planned_start, the preview is a close estimate, not a guarantee.
 */

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
export type RecurrenceEndType = 'NEVER' | 'ON_DATE' | 'AFTER_N';

/** Full recurrence rule as returned by GET /api/v1/recurrence-rules/. */
export interface TaskRecurrenceRule {
  id: string;
  server_version: number;
  task: string;
  frequency: RecurrenceFrequency;
  interval: number;
  /** Bitmask Mon=1, Tue=2, … Sun=64 (0 for non-weekly). */
  weekdays: number;
  day_of_month: number | null;
  /** "HH:MM:SS" in the rule's timezone. */
  time_of_day: string;
  /** IANA zone, e.g. "America/Los_Angeles". */
  timezone: string;
  end_type: RecurrenceEndType;
  end_date: string | null;
  end_count: number | null;
  inherit_assignee: boolean;
  inherit_subtasks: boolean;
  inherit_attachments: boolean;
  inherit_morning_notification: boolean;
  /** Internal generation cursor — read-only. */
  generated_through: string | null;
  /** Materialized occurrences so far — read-only. */
  occurrence_count: number;
}

/** Writable subset accepted by POST / PATCH (read-only fields excluded). */
export type RecurrenceRuleInput = Pick<
  TaskRecurrenceRule,
  | 'task'
  | 'frequency'
  | 'interval'
  | 'weekdays'
  | 'day_of_month'
  | 'time_of_day'
  | 'timezone'
  | 'end_type'
  | 'end_date'
  | 'end_count'
  | 'inherit_assignee'
  | 'inherit_subtasks'
  | 'inherit_attachments'
  | 'inherit_morning_notification'
>;

/**
 * Weekday columns in display order (Mon→Sun), each with its bitmask value.
 * `bit = 1 << pythonWeekday` (Mon=0 … Sun=6) — identical to the server convention
 * and `Calendar.working_days`.
 */
export const WEEKDAYS: ReadonlyArray<{ label: string; short: string; bit: number }> = [
  { label: 'Monday', short: 'M', bit: 1 },
  { label: 'Tuesday', short: 'T', bit: 2 },
  { label: 'Wednesday', short: 'W', bit: 4 },
  { label: 'Thursday', short: 'T', bit: 8 },
  { label: 'Friday', short: 'F', bit: 16 },
  { label: 'Saturday', short: 'S', bit: 32 },
  { label: 'Sunday', short: 'S', bit: 64 },
];

/** Python-style weekday (Mon=0 … Sun=6) for a JS Date (whose getDay() is Sun=0). */
export function pyWeekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** The weekday bitmask value for a date (Mon=1 … Sun=64). */
export function bitForDate(d: Date): number {
  return 1 << pyWeekday(d);
}

/** Toggle a weekday bit in a bitmask. */
export function toggleWeekday(mask: number, bit: number): number {
  return mask & bit ? mask & ~bit : mask | bit;
}

/** DST-safe ordinal day number (counts calendar days, not elapsed ms). */
function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

function diffDays(from: Date, to: Date): number {
  return dayNumber(to) - dayNumber(from);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Monday of the week containing `d` (local midnight). */
function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - pyWeekday(d));
  return m;
}

type MatchableRule = Pick<
  TaskRecurrenceRule,
  'frequency' | 'interval' | 'weekdays' | 'day_of_month'
>;

/** Whether `d` is an occurrence of `rule` given `anchor` — mirrors `_occurrence_matches`. */
function occurrenceMatches(rule: MatchableRule, anchor: Date, d: Date, interval: number): boolean {
  if (diffDays(anchor, d) < 0) return false;

  switch (rule.frequency) {
    case 'DAILY':
    case 'CUSTOM':
      return diffDays(anchor, d) % interval === 0;
    case 'WEEKLY': {
      if (!(rule.weekdays & bitForDate(d))) return false;
      const weeks = Math.floor(diffDays(mondayOf(anchor), mondayOf(d)) / 7);
      return weeks % interval === 0;
    }
    case 'MONTHLY': {
      const dom = rule.day_of_month || anchor.getDate();
      const target = Math.min(dom, daysInMonth(d.getFullYear(), d.getMonth()));
      if (d.getDate() !== target) return false;
      const months = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth());
      return months >= 0 && months % interval === 0;
    }
    default:
      return false;
  }
}

export interface OccurrencePreviewItem {
  /** Local-midnight date of the occurrence. */
  date: Date;
  /** "HH:MM" trimmed from time_of_day, for display next to the date. */
  time: string;
}

/** Safety cap so a malformed rule (e.g. weekdays=0) can never spin forever. */
const MAX_SCAN_DAYS = 366 * 5;

type PreviewableRule = MatchableRule &
  Pick<TaskRecurrenceRule, 'time_of_day' | 'end_type' | 'end_date' | 'end_count'> & {
    occurrence_count?: number;
  };

/**
 * The next `n` occurrences of `rule` on or after `from` (default: now), honoring the
 * end condition. Pure and client-only — no server round-trip. Returns fewer than `n`
 * when an end condition (ON_DATE / AFTER_N) caps the series first, and `[]` for a
 * rule that can never fire (e.g. WEEKLY with no weekday selected).
 */
export function computeNextOccurrences(
  rule: PreviewableRule,
  n: number,
  from: Date = new Date(),
): OccurrencePreviewItem[] {
  const interval = Math.max(Math.trunc(rule.interval) || 1, 1);
  const anchor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const time = (rule.time_of_day || '09:00').slice(0, 5);

  let remaining: number | null = null;
  if (rule.end_type === 'AFTER_N' && rule.end_count != null) {
    remaining = Math.max(rule.end_count - (rule.occurrence_count ?? 0), 0);
    if (remaining === 0) return [];
  }
  const endDate =
    rule.end_type === 'ON_DATE' && rule.end_date ? parseIsoDate(rule.end_date) : null;

  const out: OccurrencePreviewItem[] = [];
  const cursor = new Date(anchor);
  for (let i = 0; i < MAX_SCAN_DAYS && out.length < n; i += 1) {
    if (endDate && diffDays(endDate, cursor) > 0) break;
    if (remaining != null && out.length >= remaining) break;
    if (occurrenceMatches(rule, anchor, cursor, interval)) {
      out.push({ date: new Date(cursor), time });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Parse a "YYYY-MM-DD" date as a local-midnight Date (no timezone shift). */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Compact human label for a preview item, e.g. "Mon May 11, 09:00". */
export function formatOccurrence(item: OccurrencePreviewItem): string {
  const label = item.date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${label}, ${item.time}`;
}
