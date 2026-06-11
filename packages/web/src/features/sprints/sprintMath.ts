/**
 * Pure date math for the sprint header components.
 * Kept in a separate module so it is trivial to unit-test without a render.
 */

/** Convert a Date to a local-zone YYYY-MM-DD string. */
function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Inclusive day count between two ISO dates. */
export function daysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  const diff = (end.getTime() - start.getTime()) / 86_400_000;
  return Math.round(diff);
}

/**
 * 1-based sprint progress through its window, e.g. "Day 4 of 10".
 *
 * Caps to the inclusive total when ``today`` exceeds ``finish_date`` so the
 * UI never shows ``Day 12 of 10``. Returns ``{ day: 1, total: N }`` while the
 * sprint hasn't started yet, since the day-N-of-M ribbon is only ever rendered
 * for the active sprint anyway.
 */
export function sprintDayOf(
  startIso: string,
  finishIso: string,
  today: Date = new Date(),
): { day: number; total: number } {
  const total = daysBetween(startIso, finishIso) + 1;
  const todayIso = localDateISO(today);
  const elapsed = daysBetween(startIso, todayIso) + 1;
  if (elapsed < 1) return { day: 1, total };
  if (elapsed > total) return { day: total, total };
  return { day: elapsed, total };
}

/** Days until ``targetIso`` (negative when the date has passed). */
export function daysUntil(targetIso: string, today: Date = new Date()): number {
  const todayIso = localDateISO(today);
  return daysBetween(todayIso, targetIso);
}

/** Format an ISO date as ``Mon D`` (e.g. ``Apr 7``). */
export function formatShortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Format an ISO date range as ``Apr 7 – Apr 21``. */
export function formatDateRange(startIso: string, finishIso: string): string {
  return `${formatShortDate(startIso)} – ${formatShortDate(finishIso)}`;
}

/**
 * Forecast-transparency copy for any commitment/forecast surface (ADR-0102 §2,
 * #882 rule 153). When a sprint has pending (un-accepted) scope changes, every
 * planning surface that shows a forecast must state that the forecast reflects
 * only what the team has accepted — derived from the server's `pending_count`
 * so the client never recomputes the number, and shared so the burndown
 * caption and the sprint panel can never word it differently.
 *
 * Returns `null` when `pendingCount <= 0` — callers render nothing in that case
 * (no "0 pending" noise on a clean sprint).
 */
export function forecastScopeCaption(pendingCount: number): string | null {
  if (pendingCount <= 0) return null;
  return `Forecast reflects accepted scope only — ${pendingCount} pending acceptance`;
}

export interface CapacityPointsChip {
  /** Draft load — sum of story points over assigned tasks. */
  total: number;
  /** The team's planning ceiling (`Sprint.capacity_points`). */
  capacity: number;
  /** total ÷ capacity, rounded to a whole percent. */
  pct: number;
  /** Points still available under the ceiling (0 when at/over). */
  free: number;
  /** Points over the ceiling (0 when at/under). */
  over: number;
  /** `critical` once the draft load exceeds the ceiling, else `primary`. */
  variant: 'primary' | 'critical';
}

/**
 * Team-aggregate points load for the Capacity Preflight chip + footer band
 * (#864, ADR-0094 §3). `total` is the draft load (assigned story points) and
 * `capacity` is `Sprint.capacity_points`.
 *
 * Returns `null` when no points ceiling is set (`capacity` null / ≤ 0) — the
 * chip and footer are then omitted entirely, since a team that doesn't size in
 * points has no ceiling to compare against (the correct sentinel per ADR-0073).
 */
export function capacityPointsChip(
  total: number,
  capacity: number | null | undefined,
): CapacityPointsChip | null {
  if (capacity == null || capacity <= 0) return null;
  return {
    total,
    capacity,
    pct: Math.round((total / capacity) * 100),
    free: Math.max(0, capacity - total),
    over: Math.max(0, total - capacity),
    variant: total > capacity ? 'critical' : 'primary',
  };
}

/**
 * Predecessor-intersection count for the planning bridge banner (#866,
 * ADR-0094 §3): how many of the target milestone's predecessor tasks are
 * committed to this sprint. The raw predecessor ids come from the server
 * (`target_milestone_detail.predecessor_ids`); the intersection is computed
 * here so it stays a cheap, unit-testable derivation.
 *
 * `inSprint` ≤ `total`; `total` is the milestone's predecessor count.
 */
export function predecessorsInSprint(
  predecessorIds: readonly string[] | null | undefined,
  sprintTaskIds: readonly string[] | null | undefined,
): { inSprint: number; total: number } {
  const preds = predecessorIds ?? [];
  const inSprintSet = new Set(sprintTaskIds ?? []);
  const inSprint = preds.reduce((n, id) => (inSprintSet.has(id) ? n + 1 : n), 0);
  return { inSprint, total: preds.length };
}
