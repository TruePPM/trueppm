/**
 * Parses the demo's reset cron expression into the copy `DemoModeBar`'s secondary
 * line shows (#4152, ADR-1197 D9).
 *
 * The server carries the *cron expression that actually drives the reset CronJob*,
 * not a pre-rendered sentence — so a value this parser cannot make sense of falls
 * back to "resets periodically" rather than lying about the cadence, and nothing in
 * this module ever hardcodes a time: every number in the returned string is read
 * out of `schedule`.
 *
 * Only the simple, common daily shape (`M H * * *`) is rendered as a time. Any other
 * cron (an hourly reset, a six-hourly interval, a weekday-only schedule) is real but
 * not worth explaining to a visitor in one line, so it renders as "resets periodically".
 */

const DAILY_CRON = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/;

/**
 * @param schedule The raw `demo_reset_schedule` value from `GET /api/v1/edition/`.
 *   `null`/`undefined` (mode off, reset disabled, or a pre-0.5 server) renders nothing.
 * @param now Injected clock, so a test can pin "today" without touching the system
 *   clock. Only its UTC calendar date is used — the reset time itself comes from
 *   `schedule`.
 * @param timeZone Injected IANA zone for the "your time" conversion, so a test can
 *   assert a specific offset without depending on the machine running it. Defaults to
 *   the caller's actual zone.
 * @returns The line to render, or `null` when there is nothing to say.
 */
export function parseDemoResetLine(
  schedule: string | null | undefined,
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
): string | null {
  if (!schedule || !schedule.trim()) return null;

  const match = DAILY_CRON.exec(schedule.trim());
  if (!match) return 'Sample data · resets periodically';

  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (hour > 23 || minute > 59) return 'Sample data · resets periodically';

  const utcLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const base = `Sample data · resets daily at ${utcLabel} UTC`;

  // A concrete instant for "today at <hour>:<minute> UTC" — only the calendar date
  // is taken from `now`, so a caller in any timezone still projects the same UTC
  // moment the reset actually runs at.
  const resetInstant = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute)
  );

  const localLabel = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(resetInstant);
  // Rendered through the same formatter, pinned to UTC, so the comparison below is
  // "would this read differently to the visitor" rather than a string-equality
  // check against `utcLabel`'s own 24-hour formatting.
  const utcRendered = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(resetInstant);

  if (localLabel === utcRendered) return base;
  return `${base} (${localLabel} your time)`;
}
