import type { Methodology } from '@/types';
import type { ApiSprint, ShellStats } from '@/types';
import type { ProjectVelocity } from '@/hooks/useSprints';
import type { AddedTimePresentation } from '@/features/project/addedTime';

/**
 * Methodology-adaptive health cluster model (ADR-0128 §B).
 *
 * A single bordered cluster replaces the three free-floating TopBar badges. The
 * three segments adapt to the project methodology:
 *
 * | Methodology | Seg 1     | Seg 2    | Seg 3    |
 * |-------------|-----------|----------|----------|
 * | AGILE       | Sprint    | Points   | Velocity |
 * | WATERFALL   | Forecast  | At-risk  | Critical |
 * | HYBRID      | Sprint    | Forecast | Critical |
 *
 * `healthClusterModel` is a pure function of the already-cached query data so the
 * renderer never branches on raw nulls — every state (no active sprint, no points,
 * scheduler-not-run, ADR-0104 velocity-suppressed) is a first-class union member.
 */

interface BadgeTaskItem {
  id: string;
  wbs: string;
  name: string;
}

export type HealthSegment =
  /** Monte Carlo forecast band: P50 + P80 completion dates (issue 1197). `p80` null =
   *  the scheduler has not run (renders muted "—"); `p50` null = no MC distribution
   *  is cached yet, so the slot shows P80 alone. */
  | { kind: 'forecast'; p50: string | null; p80: string | null }
  | { kind: 'atRisk'; count: number; items: BadgeTaskItem[] }
  | { kind: 'critical'; count: number; items: BadgeTaskItem[] }
  /** Active sprint name + inclusive Day n/m. */
  | { kind: 'sprint'; name: string; dayN: number; dayM: number }
  /** No active sprint — links to the sprints view. */
  | { kind: 'sprintEmpty' }
  | { kind: 'points'; completed: number; committed: number; unit: 'pts' | 'items' }
  /** Velocity is in-audience: avg points per iteration + forecast band + excluded count.
   *  `avg` null = not enough closed-sprint history yet (renders muted "—"). */
  | { kind: 'velocity'; avg: number | null; low: number | null; high: number | null; excluded: number }
  /** ADR-0104: requester is below the velocity signal's audience — render the
   *  content-free privacy wall (rule 168), never a number. */
  | { kind: 'velocityGated' }
  /** "Added time" — the gap between the CPM finish and the P80 commit (#2531).
   *  Carries the already-classified presentation rather than the raw day count, so
   *  no renderer can decide for itself what a premium of `0` means. Appended for
   *  every methodology (a forecast is not agile-specific) and omitted entirely when
   *  the surface owns the value itself — see `addedTime` on the input. */
  | { kind: 'addedTime'; presentation: AddedTimePresentation };

export interface HealthClusterInput {
  methodology: Methodology;
  stats: ShellStats | undefined;
  activeSprint: ApiSprint | null;
  velocity: ProjectVelocity | undefined;
  /** Latest Monte Carlo percentiles for the forecast band (issue 1197). P50 is sourced
   *  here from the cached distribution that already drives the drill-through panel;
   *  P80 still falls back to the status-summary value when no MC result is cached. */
  mc: { p50: string | null; p80: string | null } | undefined;
  /** Added time for this project, or `null` to omit the segment entirely (#2531).
   *  The model stays route-unaware: the caller resolves rule-284 suppression with
   *  `addedTimeChipContext` and passes `null` on the surfaces that render the value
   *  themselves, so the segment list never carries a value the screen already shows. */
  addedTime: AddedTimePresentation | null;
  /** `new Date()` injected by the caller so the selector stays pure/testable. */
  now: Date;
}

/** Parse a `yyyy-mm-dd` ISO date as a UTC midnight Date (DST-safe, like the engine). */
function parseUTCDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

const MS_PER_DAY = 86_400_000;

/**
 * Inclusive day index of `now` within `[start, finish]`, 1-based and clamped to
 * `[1, total]`. A sprint spanning Mon→Fri (5 days) on its Wednesday is "Day 3/5".
 */
export function sprintDay(startIso: string, finishIso: string, now: Date): { dayN: number; dayM: number } {
  const start = parseUTCDate(startIso);
  const finish = parseUTCDate(finishIso);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayM = Math.max(1, Math.round((finish - start) / MS_PER_DAY) + 1);
  const raw = Math.round((today - start) / MS_PER_DAY) + 1;
  const dayN = Math.min(Math.max(raw, 1), dayM);
  return { dayN, dayM };
}

function sprintSegment(activeSprint: ApiSprint | null, now: Date): HealthSegment {
  if (!activeSprint) return { kind: 'sprintEmpty' };
  const { dayN, dayM } = sprintDay(activeSprint.start_date, activeSprint.finish_date, now);
  return { kind: 'sprint', name: activeSprint.name, dayN, dayM };
}

function forecastSegment(
  stats: ShellStats | undefined,
  mc: { p50: string | null; p80: string | null } | undefined,
): HealthSegment {
  // P50 comes from the cached MC distribution that drives the forecast
  // drill-through panel (issue 1197). P80 prefers the status-summary value and
  // still falls back to the live MC result — but the reason has changed (#2903).
  // The fallback was added for ADR-0144 / issue 1231 because status-summary
  // hard-coded monte_carlo_p80 = null, so its branch was dead by construction and
  // every read fell through. status-summary now returns the persisted run's p80,
  // so the first branch is live and the fallback is a genuine one: the two reads
  // resolve independently, and `mc` can land first.
  return {
    kind: 'forecast',
    p50: mc?.p50 ?? null,
    p80: stats?.monteCarlop80 ?? mc?.p80 ?? null,
  };
}

function atRiskSegment(stats: ShellStats | undefined): HealthSegment {
  return { kind: 'atRisk', count: stats?.atRiskCount ?? 0, items: stats?.atRiskTasks ?? [] };
}

function criticalSegment(stats: ShellStats | undefined): HealthSegment {
  return { kind: 'critical', count: stats?.criticalCount ?? 0, items: stats?.criticalTasks ?? [] };
}

/**
 * Points segment — throughput-neutral (ADR-0128 §B; throughput-basis follow-up). Points when the team
 * sizes in them, else an item count, else omitted entirely (returns null) so a
 * no-points/no-count team is never shown an empty "Points" badge.
 */
function pointsSegment(activeSprint: ApiSprint | null): HealthSegment | null {
  if (!activeSprint) return null;
  if (activeSprint.committed_points != null) {
    return {
      kind: 'points',
      completed: activeSprint.completed_points ?? 0,
      committed: activeSprint.committed_points,
      unit: 'pts',
    };
  }
  if (activeSprint.committed_task_count != null) {
    return {
      kind: 'points',
      completed: activeSprint.completed_task_count ?? 0,
      committed: activeSprint.committed_task_count,
      unit: 'items',
    };
  }
  return null;
}

/**
 * Velocity segment — gated by ADR-0104. When the server marks the payload
 * `velocity_suppressed`, the requester is out of audience: render the privacy wall
 * with no number (the client never received one).
 */
function velocitySegment(velocity: ProjectVelocity | undefined): HealthSegment {
  if (velocity?.velocity_suppressed) return { kind: 'velocityGated' };
  return {
    kind: 'velocity',
    avg: velocity?.rolling_avg_points ?? null,
    low: velocity?.forecast_range_low ?? null,
    high: velocity?.forecast_range_high ?? null,
    excluded: velocity?.excluded_count ?? 0,
  };
}

/** The methodology's own 2—3 segments, before the methodology-neutral tail. */
function methodologySegments(input: HealthClusterInput): HealthSegment[] {
  const { methodology, stats, activeSprint, velocity, mc, now } = input;

  if (methodology === 'WATERFALL') {
    return [forecastSegment(stats, mc), atRiskSegment(stats), criticalSegment(stats)];
  }

  if (methodology === 'HYBRID') {
    return [sprintSegment(activeSprint, now), forecastSegment(stats, mc), criticalSegment(stats)];
  }

  // AGILE
  const points = pointsSegment(activeSprint);
  return [
    sprintSegment(activeSprint, now),
    ...(points ? [points] : []),
    velocitySegment(velocity),
  ];
}

/**
 * Build the ordered segments: the methodology's 2—3, plus added time when this surface
 * does not already render it.
 *
 * AGILE may contribute 2 when the team sizes in neither points nor counts (the Points
 * slot is omitted); every other methodology contributes exactly 3.
 *
 * Added time is methodology-neutral — a forecast premium is not an agile or a
 * waterfall fact — but its *position* is not free. It sits immediately after the
 * forecast segment, because it is a delta measured from the forecast's own baseline
 * and the at-risk / critical segments below expand into task drill lists. Appended
 * last, it would land a dozen rows below the date it is measured against on a busy
 * project, which is the separated-delta defect #2426 fixed. With no forecast segment
 * to anchor to (AGILE) it goes last, where it is still self-verifying because the row
 * carries its own baseline date.
 */
export function healthClusterModel(input: HealthClusterInput): HealthSegment[] {
  const segments = methodologySegments(input);
  if (input.addedTime === null) return segments;

  const addedTime: HealthSegment = { kind: 'addedTime', presentation: input.addedTime };
  const forecastAt = segments.findIndex((s) => s.kind === 'forecast');
  if (forecastAt === -1) return [...segments, addedTime];
  return [...segments.slice(0, forecastAt + 1), addedTime, ...segments.slice(forecastAt + 1)];
}
