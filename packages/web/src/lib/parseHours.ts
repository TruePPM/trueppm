/**
 * Decimal/clock hours parsing + display for the weekly timesheet grid (#1435, ADR-0224).
 *
 * The grid stores canonical integer **minutes** (the server's `TimeEntry.minutes`,
 * 1..1440); the contributor types hours in whichever shorthand is fastest. These are
 * pure so the grid can parse-on-Enter and format-on-render without a round-trip, and
 * they are unit-tested in isolation.
 */

/** A day-total at or over this many minutes (8h) is flagged (amber) as an over-long day. */
export const OVER_DAILY_MINUTES = 8 * 60;

/** Max minutes a single grid cell may hold — mirrors the server's `TimeEntry` 1..1440 cap. */
const MAX_CELL_MINUTES = 24 * 60;

/**
 * Parse a contributor's hours shorthand into whole minutes.
 *
 * Accepts three fast forms plus their obvious variants:
 *   - decimal hours: `2` → 120, `2.5` → 150, `.5` → 30, `0` → 0
 *   - clock hours:   `2:30` → 150, `0:15` → 15, `1:5` → 65
 *   - blank / whitespace → 0 (an empty cell / a cleared cell)
 *
 * Returns whole minutes, or `null` when the input is unparseable or out of range
 * (negative, or over 24h — the server would reject it anyway). `0` is a valid parse
 * (the grid treats it as "clear this cell"), distinct from `null` (invalid — reject the
 * edit and keep the prior value).
 */
export function parseHoursToMinutes(raw: string): number | null {
  const input = raw.trim();
  if (input === '') return 0;

  let minutes: number;
  if (input.includes(':')) {
    // Clock form h:mm — both parts must be digits; minutes 0..59.
    const parts = input.split(':');
    if (parts.length !== 2) return null;
    const [h, m] = parts;
    if (!/^\d+$/.test(h) || !/^\d+$/.test(m)) return null;
    const mins = Number(m);
    if (mins > 59) return null;
    minutes = Number(h) * 60 + mins;
  } else {
    // Decimal-hours form — allow a leading dot (`.5`) and at most one dot.
    // Unambiguous decimal-hours match: an integer with an optional fraction, or a
    // bare leading-dot fraction (`.5`). Splitting the alternatives removes the
    // `\d*\.?\d+` digit-overlap that SonarQube S5852 flags as super-linear.
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(input) && !/^\d+\.$/.test(input)) return null;
    const hours = Number(input);
    if (Number.isNaN(hours)) return null;
    minutes = Math.round(hours * 60);
  }

  if (minutes < 0 || minutes > MAX_CELL_MINUTES) return null;
  return minutes;
}

/**
 * Format whole minutes as clock hours `h:mm` (e.g. `150` → `"2:30"`, `65` → `"1:05"`).
 *
 * Used for row / daily / week totals and for a cell's committed value, so the grid reads
 * in one consistent unit (matching the shipped header rollup's `8:45` / `21:30` language,
 * not a decimal-hours mix). Guards non-finite / negative input to `"0:00"`.
 */
export function formatMinutesAsHm(totalMinutes: number): string {
  const safe = Number.isFinite(totalMinutes) ? Math.max(0, Math.round(totalMinutes)) : 0;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}
