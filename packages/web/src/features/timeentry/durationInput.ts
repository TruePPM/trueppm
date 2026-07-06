/**
 * Parse a manually-typed duration into whole minutes for the quick-log popover
 * (issue 1416). Accepts the three shapes a contributor naturally types:
 *
 *   - `"1:30"`  → 90   (h:mm clock form; minutes part 0–59)
 *   - `"90"`    → 90   (a bare integer is minutes)
 *   - `"1.5"`   → 90   (a decimal is hours — "1.5h" without the h)
 *
 * Returns null for anything unparseable or outside the server's 1..1440-minute
 * bound (`TimeEntry.minutes` validators), so the caller can disable Log without
 * a round-trip. Zero is rejected — logging nothing is not a log.
 */
const MAX_MINUTES = 1440;

export function parseDurationToMinutes(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  let minutes: number | null = null;

  const clock = /^(\d+):([0-5]?\d)$/.exec(trimmed);
  const decimal = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (clock) {
    minutes = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (decimal) {
    minutes = Math.round(Number(trimmed) * 60);
  } else if (/^\d+$/.test(trimmed)) {
    minutes = Number(trimmed);
  }

  if (minutes === null || minutes <= 0 || minutes > MAX_MINUTES) return null;
  return minutes;
}
