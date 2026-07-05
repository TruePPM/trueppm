// ---------------------------------------------------------------------------
// My Work v2 — greeting + focus-card derivation
//
// The v2 My Work spec leads the home surface with a time-aware greeting and
// three risk-ranked focus cards (the same "worst signal leads" idea the project
// Overview uses via overviewMetrics). My Work is *cross-program*, so a card is
// enriched with a rich project-level signal ONLY where a real server-side
// computation backs it (#1236, ADR-0221): the /me/work/ `signals` block supplies
// cross-program schedule health (SPI-proxy), a Monte-Carlo P80 ship-date
// forecast, and a real per-day sprint burndown series. Team utilization is
// deliberately absent — no cross-program per-user capacity computation exists, so
// the "your load" card stays an honest open-task count rather than a fabricated
// ratio (rule 120: never fabricate a number). Every card also degrades
// gracefully when its signal is missing. All functions are pure so they
// unit-test in isolation from the React tree.
// ---------------------------------------------------------------------------

import type { OverviewMetricVariant } from '@/features/project/overviewMetrics';
import type { MyWorkTask, MyWorkActiveSprint, MyWorkSignals } from '@/hooks/useMyWork';

/** A single focus card on the My Work home. */
export interface MyWorkFocusCard {
  /** Stable key for React + tiebreak ordering. */
  key: 'needs_attention' | 'sprint' | 'critical_path' | 'load';
  /** Mono kicker label (uppercase in the view). */
  label: string;
  /** Big display value. */
  value: string;
  /** Optional mono delta/context beside the value. */
  delta?: string;
  /** Drives the value color + the focus heading (worst-first severity). */
  variant: OverviewMetricVariant;
  /**
   * Optional sparkline heights (0–1) for the sprint card. Rendered as a small
   * bar spark; absent on every other card. Honest only when derived from real
   * progress — a real cross-program burndown series (#1236) when the server
   * supplies one, else a direction-only completion ramp; never random filler.
   */
  spark?: number[];
  /**
   * Optional second labeled line beneath the value — a real server-computed
   * figure the card enriches with (#1236): the cross-program schedule-health
   * band on the "needs attention" card, or the sprint burn pace on the sprint
   * card. Its own tone so it never inherits (or masks) the primary value color.
   * The text carries the meaning; color is redundant (rule 6 / a11y).
   */
  detail?: { text: string; tone: OverviewMetricVariant };
}

/** Schedule-health band → focus-card tone + human label. */
const HEALTH_BAND: Record<
  NonNullable<MyWorkSignals['schedule_health']>['band'],
  { tone: OverviewMetricVariant; label: string }
> = {
  on_track: { tone: 'on-track', label: 'On track' },
  at_risk: { tone: 'at-risk', label: 'At risk' },
  critical: { tone: 'critical', label: 'Critical' },
};

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/**
 * Map a local hour (0–23) to the greeting band. Morning < 12, afternoon < 18,
 * evening otherwise — the boundaries a person reads as natural.
 */
export function timeOfDay(hour: number): TimeOfDay {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

const GREETING: Record<TimeOfDay, string> = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
};

/**
 * Compose the greeting headline, e.g. "Good morning, Anika." When the name is
 * unknown (pre-load or a server without a display name) it degrades to the
 * generic "Good morning." with no trailing comma.
 */
export function greeting(name: string | undefined, now: Date): string {
  const lead = GREETING[timeOfDay(now.getHours())];
  const trimmed = name?.trim();
  return trimmed ? `${lead}, ${trimmed}.` : `${lead}.`;
}

/**
 * The sub line under the greeting: "{N} tasks need you today · {M} on the
 * critical path". Both clauses self-suppress at zero — an all-clear day reads
 * "You're all caught up." rather than "0 tasks need you today". Plain language;
 * no CPM vocabulary beyond the spec's "critical path".
 */
export function greetingSubline(dueTodayCount: number, criticalCount: number): string {
  const parts: string[] = [];
  if (dueTodayCount > 0) {
    // Subject-verb agreement: "1 task needs you" / "5 tasks need you".
    parts.push(
      dueTodayCount === 1 ? '1 task needs you today' : `${dueTodayCount} tasks need you today`,
    );
  }
  if (criticalCount > 0) {
    parts.push(`${criticalCount} on the critical path`);
  }
  if (parts.length === 0) return "You're all caught up.";
  return parts.join(' · ');
}

/** Format the date chip, e.g. "Tuesday, June 17". */
export function dateChip(now: Date): string {
  return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

const OPEN_STATUSES: ReadonlySet<MyWorkTask['status']> = new Set([
  'NOT_STARTED',
  'IN_PROGRESS',
  'REVIEW',
  'ON_HOLD',
]);

/** Heights for the sprint spark, derived from completed/total share (0–1). */
function sprintSpark(completedShare: number): number[] {
  // A five-step rising ramp that ends at the real completion share. It encodes
  // direction (progress toward done), not a fabricated per-day series we don't
  // have cross-program. The final bar carries the true value so the spark never
  // overstates progress. Used only as the honest fallback when the server does
  // NOT supply a real burndown series (#1236).
  const end = Math.min(1, Math.max(0.08, completedShare));
  return [0.25 * end, 0.5 * end, 0.7 * end, 0.85 * end, end];
}

/**
 * Heights for a REAL burndown spark from the server's per-day remaining series
 * (#1236). Each bar is that day's remaining points as a share of the committed
 * baseline (or the series peak when scope grew past commitment), so the spark
 * literally is the sprint's burndown — the last bar is today's true remaining.
 * Returns undefined for an empty series so the caller falls back honestly.
 */
export function burndownSpark(
  series: { remaining_points: number }[],
  committedPoints: number,
): number[] | undefined {
  if (series.length === 0) return undefined;
  const peak = Math.max(committedPoints, ...series.map((p) => p.remaining_points), 1);
  return series.map((p) => Math.max(0.06, p.remaining_points / peak));
}

/**
 * Human burn-pace line for the sprint card detail (#1236) from the server's
 * `burn_status` + signed `trend_points`. Returns undefined when there is no
 * baseline to measure against (`no_data`), so no pace line is shown.
 */
export function burnPaceDetail(
  status: 'ahead' | 'on_track' | 'behind' | 'no_data',
  trendPoints: number | null,
): { text: string; tone: OverviewMetricVariant } | undefined {
  if (status === 'no_data' || trendPoints === null) return undefined;
  const pts = Math.abs(trendPoints);
  if (status === 'behind') return { text: `${pts} pt${pts === 1 ? '' : 's'} behind`, tone: 'at-risk' };
  if (status === 'ahead') return { text: `${pts} pt${pts === 1 ? '' : 's'} ahead`, tone: 'on-track' };
  return { text: 'On track', tone: 'neutral' };
}

/**
 * Build the three (or two) focus cards from the My Work payload.
 *
 * - **Card 1 "Needs attention"** — your blocked + critical-path task count.
 *   critical variant if anything is blocked, at-risk if anything is on the
 *   critical path, on-track when clear. Always present.
 * - **Card 2 method-driven** — a sprint summary card (days remaining + task
 *   count + a progress spark) when the user has an active sprint; otherwise a
 *   critical-path mini ("on the critical path" count, the waterfall variant).
 *   Cross-program with no single methodology, so the active sprint *implies*
 *   the method (rule: degrade to the critical-path variant when sprintless).
 * - **Card 3 "Your load"** — your count of open (non-complete) assigned tasks,
 *   with due-today as the delta. Dropped (returns 2 cards) only if the user has
 *   no open work at all, where a "0 open" load card is noise.
 *
 * When the server supplies real cross-program `signals` (#1236, ADR-0221) the
 * cards are enriched *only* where a real computation backs the number (rule 120):
 * the "needs attention" card gains a schedule-health (SPI-proxy) detail line, and
 * the sprint card's spark becomes the real burndown series with a real pace line.
 * Utilization stays honestly absent — there is no cross-program per-user capacity
 * computation, so the "your load" card remains an open-task count, not a ratio.
 *
 * @param tasks        All loaded My Work tasks (across pages).
 * @param activeSprints The active-sprint cards from the first page.
 * @param dueTodayCount Server due-today count.
 * @param signals      Optional cross-program aggregates (first page only, #1236).
 * @returns 2 or 3 cards, already in render order (worst signal leads).
 */
export function buildMyWorkFocusCards(
  tasks: MyWorkTask[],
  activeSprints: MyWorkActiveSprint[],
  dueTodayCount: number,
  signals?: MyWorkSignals,
): MyWorkFocusCard[] {
  const blockedCount = tasks.filter((t) => t.is_blocked).length;
  const criticalCount = tasks.filter((t) => t.is_critical).length;
  const openCount = tasks.filter((t) => OPEN_STATUSES.has(t.status)).length;
  const attentionCount = blockedCount + criticalCount;

  // ── Card 1: Needs attention ─────────────────────────────────────────────
  const attentionVariant: OverviewMetricVariant = blockedCount
    ? 'critical'
    : criticalCount
      ? 'at-risk'
      : 'on-track';
  const attentionDelta = blockedCount
    ? `${blockedCount} blocked`
    : criticalCount
      ? 'on the critical path'
      : 'nothing flagged';
  const needsAttention: MyWorkFocusCard = {
    key: 'needs_attention',
    label: 'Needs attention',
    value: String(attentionCount),
    delta: attentionDelta,
    variant: attentionVariant,
  };
  // Real cross-program schedule-health figure (#1236) as a labeled detail line —
  // separate tone so it never masks the blocked/critical value color above it.
  const health = signals?.schedule_health;
  if (health) {
    const band = HEALTH_BAND[health.band];
    needsAttention.detail = {
      text: `Schedule ${band.label.toLowerCase()} · ${health.project_count} project${
        health.project_count === 1 ? '' : 's'
      }`,
      tone: band.tone,
    };
  }

  // ── Card 2: method-driven (sprint → critical-path fallback) ─────────────
  let methodCard: MyWorkFocusCard;
  if (activeSprints.length > 0) {
    // Soonest-ending sprint leads — the one whose clock matters most.
    const sprint = [...activeSprints].sort((a, b) => a.days_remaining - b.days_remaining)[0];
    // Approximate completion as the share of this user's open work that is NOT
    // in this sprint — an honest local signal (we have no server burndown
    // cross-program). When we can't infer any progress the spark sits low.
    const sprintTasks = tasks.filter((t) => t.sprint_id === sprint.id);
    const sprintOpen = sprintTasks.filter((t) => OPEN_STATUSES.has(t.status)).length;
    const completedShare = sprintTasks.length
      ? (sprintTasks.length - sprintOpen) / sprintTasks.length
      : 0;
    const daysVariant: OverviewMetricVariant =
      sprint.days_remaining <= 1 ? 'at-risk' : 'neutral';
    // Prefer the server's real burndown series (#1236) when it is for THIS lead
    // sprint; else fall back to the honest direction-only completion ramp.
    const burndown =
      signals?.sprint_burndown?.sprint_id === sprint.id ? signals.sprint_burndown : undefined;
    const realSpark = burndown
      ? burndownSpark(burndown.series, burndown.committed_points)
      : undefined;
    methodCard = {
      key: 'sprint',
      label: sprint.name,
      value: `${sprint.days_remaining}d`,
      delta:
        sprint.days_remaining === 1
          ? '1 day left'
          : sprint.days_remaining <= 0
            ? 'ends today'
            : 'days left',
      variant: daysVariant,
      spark: realSpark ?? sprintSpark(completedShare),
      // Real burn pace as the detail line — omitted when there's no baseline.
      detail: burndown ? burnPaceDetail(burndown.burn_status, burndown.trend_points) : undefined,
    };
  } else {
    methodCard = {
      key: 'critical_path',
      label: 'On the critical path',
      value: String(criticalCount),
      delta: criticalCount ? 'a delay here slips the date' : 'none of yours',
      variant: criticalCount ? 'at-risk' : 'neutral',
    };
  }

  // ── Card 3: Your load ───────────────────────────────────────────────────
  // Honest cross-program load = your open assigned-task count. No utilization %
  // is available across programs, so we count work rather than capacity. Drop
  // the card entirely (2-up) when there is no open work to weigh.
  const cards: MyWorkFocusCard[] = [needsAttention, methodCard];
  if (openCount > 0) {
    cards.push({
      key: 'load',
      label: 'Your load',
      value: String(openCount),
      delta: dueTodayCount > 0 ? `${dueTodayCount} due today` : 'open tasks',
      variant: 'neutral',
    });
  }
  return cards;
}

/**
 * The focus-row heading: "Needs attention" when any focus card is at-risk or
 * critical, otherwise the calm "Your day". Mirrors overviewMetrics.focusHeading.
 */
export function myWorkFocusHeading(cards: MyWorkFocusCard[]): string {
  const hasProblem = cards.some((c) => c.variant === 'at-risk' || c.variant === 'critical');
  return hasProblem ? 'Needs attention' : 'Your day';
}
