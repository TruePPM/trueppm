// ---------------------------------------------------------------------------
// My Work v2 — greeting + focus-card derivation
//
// The v2 My Work spec leads the home surface with a time-aware greeting and
// three risk-ranked focus cards (the same "worst signal leads" idea the project
// Overview uses via overviewMetrics). My Work is *cross-program*, so the rich
// project-level signals the spec's mockups reference — SPI, Monte-Carlo P80,
// team utilization, a real sprint burndown — are NOT available here. This module
// builds each card honestly from the data the /me/work/ payload actually
// returns and degrades gracefully when a card has nothing to show (rule 120:
// never fabricate a number). All functions are pure so they unit-test in
// isolation from the React tree.
// ---------------------------------------------------------------------------

import type { OverviewMetricVariant } from '@/features/project/overviewMetrics';
import type { MyWorkTask, MyWorkActiveSprint } from '@/hooks/useMyWork';

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
   * progress — never random filler.
   */
  spark?: number[];
}

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
  // overstates progress.
  const end = Math.min(1, Math.max(0.08, completedShare));
  return [0.25 * end, 0.5 * end, 0.7 * end, 0.85 * end, end];
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
 * No SPI / Monte-Carlo P80 / utilization is available cross-program, so those
 * spec signals are deliberately not rendered (would be fabricated — rule 120).
 *
 * @param tasks        All loaded My Work tasks (across pages).
 * @param activeSprints The active-sprint cards from the first page.
 * @param dueTodayCount Server due-today count.
 * @returns 2 or 3 cards, already in render order (worst signal leads).
 */
export function buildMyWorkFocusCards(
  tasks: MyWorkTask[],
  activeSprints: MyWorkActiveSprint[],
  dueTodayCount: number,
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
      spark: sprintSpark(completedShare),
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
