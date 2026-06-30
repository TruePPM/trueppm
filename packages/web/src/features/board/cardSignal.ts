/**
 * Worst-offender card signal classifier (#1305, ADR-0191 §4).
 *
 * A board card carries many independent health signals (blocked, stale, critical
 * path, negative float, behind on EVM). Rendering them all at once reads as noise,
 * so at comfortable density the card shows only the single **highest-severity**
 * signal as one primary badge; the full chip set is reachable behind a peek.
 *
 * The severity order is **objective and neutral by design** (VoC: Morgan) — it is
 * derived from delivery signals, never from PM-assigned priority rank. Priority
 * rank stays a separate corner affordance. The order is fixed by ADR-0191 §4:
 *
 *   blocked → over-SLA / stalled → critical-path / negative-float → behind (EVM)
 *
 * The classifier is pure and total: it never throws and returns `null` for an
 * on-track card (no badge → calm card). It is the single source of truth for the
 * ordering so the badge and any future consumer can never disagree (same
 * discipline as `wip.ts` / `boardGrid.ts`).
 */

/** Severity tone — maps to the design-system `-bg` token pairing (rule 8b). */
export type CardSignalTone = 'critical' | 'at-risk';

/** The severity tier a card falls into, highest-severity first. */
export type CardSignalTier = 'blocked' | 'stale' | 'critical' | 'behind';

/**
 * The already-hydrated, already-derived inputs the classifier reads. BoardCard
 * computes these once; passing them in (rather than the raw `Task`) keeps this
 * module pure and avoids re-deriving float / dwell / scheduled gates here.
 */
export interface CardSignalInput {
  /** Task is blocked by an incomplete predecessor (ADR-0115). */
  isBlocked: boolean;
  /** Number of predecessors — surfaced as a non-lossy count on the blocked badge. */
  predecessorCount: number;
  /** Dwell time in the current column exceeds the column SLA (issue #192). */
  isAging: boolean;
  /** No movement for longer than the staleness threshold (entry stamp). */
  isStalled: boolean;
  /** Dwell exceeds twice the SLA — escalates the stale tone to critical. */
  isPastTwiceSla: boolean;
  /** Calendar days in the current column, or null when unknown. */
  daysAgo: number | null;
  /** The card's *display* critical-path state (scheduled, not pending). */
  showCriticalState: boolean;
  /**
   * Total float in days, or null when the task has no float data (unscheduled).
   * Negative float means the task is forecast to finish past its constraint.
   */
  floatDays: number | null;
  /** Server-owned schedule-performance band (#990), or null when no EVM data. */
  spiBand: 'on_track' | 'at_risk' | 'behind' | null;
  /** Cost-performance index, or null when no cost data. */
  cpi: number | null;
}

/** The resolved worst-offender signal, or `null` when the card is on track. */
export interface CardSignal {
  tier: CardSignalTier;
  /** Decorative glyph (always paired with `label` — never color-only, rule 12). */
  glyph: string;
  /** Short visible badge label, e.g. "Blocked · 2 deps", "3d late", "Stale 6d". */
  label: string;
  tone: CardSignalTone;
  /** Verbose screen-reader description of the signal. */
  srText: string;
}

/**
 * Resolve the single highest-severity signal for a card.
 *
 * First match wins, evaluated in the fixed ADR-0191 §4 order, so a card that is
 * both blocked and on the critical path reports **Blocked** (the more actionable
 * signal). Returns `null` for an on-track card.
 */
export function classifyCardSignal(input: CardSignalInput): CardSignal | null {
  // 1. Blocked — the most actionable signal: work cannot proceed.
  if (input.isBlocked) {
    const deps =
      input.predecessorCount > 0
        ? ` · ${input.predecessorCount} dep${input.predecessorCount === 1 ? '' : 's'}`
        : '';
    const srDeps =
      input.predecessorCount > 0
        ? `, ${input.predecessorCount} dependenc${input.predecessorCount === 1 ? 'y' : 'ies'}`
        : '';
    return {
      tier: 'blocked',
      glyph: '⛔',
      label: `Blocked${deps}`,
      tone: 'critical',
      srText: `Blocked${srDeps}`,
    };
  }

  // 2. Stale — sitting in a column past its SLA. Twice the SLA is critical.
  // The escalation carries in the label ("Very stale"), not in color alone
  // (rule 12): a sighted user must distinguish at-risk from critical without
  // relying on the amber/red tone.
  if (input.isAging && (input.isStalled || input.isPastTwiceSla)) {
    const days = input.daysAgo ?? 0;
    return {
      tier: 'stale',
      glyph: '⚡',
      label: `${input.isPastTwiceSla ? 'Very stale' : 'Stale'} ${days}d`,
      tone: input.isPastTwiceSla ? 'critical' : 'at-risk',
      srText: `Stale, ${days} days in column${input.isPastTwiceSla ? ', over twice the limit' : ''}`,
    };
  }

  // 3. Critical path / negative float — schedule risk that endangers the finish.
  const negativeFloat = input.floatDays != null && input.floatDays < 0;
  if (input.showCriticalState || negativeFloat) {
    const label = negativeFloat ? `${Math.abs(input.floatDays as number)}d late` : 'Critical path';
    const srText = negativeFloat
      ? `${Math.abs(input.floatDays as number)} days behind, negative float`
      : 'On the critical path';
    return { tier: 'critical', glyph: '⚑', label, tone: 'critical', srText };
  }

  // 4. Behind on earned value — slipping but not yet schedule-critical.
  const cpiBehind = input.cpi != null && input.cpi < 0.85;
  if (input.spiBand === 'behind' || input.spiBand === 'at_risk' || cpiBehind) {
    const hard = input.spiBand === 'behind' || cpiBehind;
    return {
      tier: 'behind',
      glyph: '📉',
      label: hard ? 'Behind' : 'At risk',
      tone: hard ? 'critical' : 'at-risk',
      srText: hard ? 'Behind schedule on earned value' : 'Schedule at risk on earned value',
    };
  }

  // 5. On track — no primary badge (calm card).
  return null;
}

/** Tailwind classes for a signal pill, by tone — the rule 8b `-bg` pairing. */
export function cardSignalToneClass(tone: CardSignalTone): string {
  return tone === 'critical'
    ? 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40'
    : 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40';
}
