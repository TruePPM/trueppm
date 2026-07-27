/**
 * Worst-offender card signal classifier (issue 1305, ADR-0191 §4).
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

import type { ComponentType } from 'react';
import { BanIcon, BoltIcon, FlagIcon, TrendDownIcon, type IconProps } from '@/components/Icons';

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
  /** Dwell time in the current column exceeds the column SLA (issue 192). */
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
  /** Server-owned schedule-performance band (issue 990), or null when no EVM data. */
  spiBand: 'on_track' | 'at_risk' | 'behind' | null;
  /** Cost-performance index, or null when no cost data. */
  cpi: number | null;
}

/** The resolved worst-offender signal, or `null` when the card is on track. */
export interface CardSignal {
  tier: CardSignalTier;
  /**
   * Decorative icon component (always paired with `label` — never color-only,
   * rule 12).
   *
   * A **component**, not an emoji string (#1749): the glyph is a functional
   * status affordance, and an emoji renders at the mercy of the platform font —
   * different shape, different color, sometimes a tofu box on Linux. Rendering it
   * as a house SVG makes the mark identical everywhere and lets it inherit
   * `currentColor` from the signal tone. Render sites destructure it as a
   * capitalized binding (`const { Icon } = signal`) so JSX treats it as a
   * component rather than an intrinsic element.
   */
  Icon: ComponentType<IconProps>;
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
  // The ADR-0191 §4 severity order, most actionable first. Each rule returns null
  // when it does not apply, so the chain *is* the precedence — and an on-track
  // card falls through all four to null (no primary badge, calm card).
  return (
    blockedSignal(input) ?? staleSignal(input) ?? criticalSignal(input) ?? behindSignal(input)
  );
}

/** 1. Blocked — the most actionable signal: work cannot proceed. */
function blockedSignal(input: CardSignalInput): CardSignal | null {
  if (!input.isBlocked) return null;
  const count = input.predecessorCount;
  const deps = count > 0 ? ` · ${count} dep${count === 1 ? '' : 's'}` : '';
  const srDeps = count > 0 ? `, ${count} dependenc${count === 1 ? 'y' : 'ies'}` : '';
  return {
    tier: 'blocked',
    Icon: BanIcon,
    label: `Blocked${deps}`,
    tone: 'critical',
    srText: `Blocked${srDeps}`,
  };
}

/**
 * 2. Stale — sitting in a column past its SLA. Twice the SLA is critical.
 *
 * The escalation carries in the label ("Very stale"), not in color alone
 * (rule 12): a sighted user must distinguish at-risk from critical without
 * relying on the amber/red tone.
 */
function staleSignal(input: CardSignalInput): CardSignal | null {
  if (!input.isAging || !(input.isStalled || input.isPastTwiceSla)) return null;
  const days = input.daysAgo ?? 0;
  const veryStale = input.isPastTwiceSla;
  return {
    tier: 'stale',
    Icon: BoltIcon,
    label: `${veryStale ? 'Very stale' : 'Stale'} ${days}d`,
    tone: veryStale ? 'critical' : 'at-risk',
    srText: `Stale, ${days} days in column${veryStale ? ', over twice the limit' : ''}`,
  };
}

/** 3. Critical path / negative float — schedule risk that endangers the finish. */
function criticalSignal(input: CardSignalInput): CardSignal | null {
  const negativeFloat = input.floatDays != null && input.floatDays < 0;
  if (!input.showCriticalState && !negativeFloat) return null;
  const lateDays = negativeFloat ? Math.abs(input.floatDays as number) : 0;
  return {
    tier: 'critical',
    Icon: FlagIcon,
    label: negativeFloat ? `${lateDays}d late` : 'Critical path',
    tone: 'critical',
    srText: negativeFloat ? `${lateDays} days behind, negative float` : 'On the critical path',
  };
}

/** 4. Behind on earned value — slipping but not yet schedule-critical. */
function behindSignal(input: CardSignalInput): CardSignal | null {
  const cpiBehind = input.cpi != null && input.cpi < 0.85;
  if (input.spiBand !== 'behind' && input.spiBand !== 'at_risk' && !cpiBehind) return null;
  const hard = input.spiBand === 'behind' || cpiBehind;
  return {
    tier: 'behind',
    Icon: TrendDownIcon,
    label: hard ? 'Behind' : 'At risk',
    tone: hard ? 'critical' : 'at-risk',
    srText: hard ? 'Behind schedule on earned value' : 'Schedule at risk on earned value',
  };
}

/** Tailwind classes for a signal pill, by tone — the rule 8b `-bg` pairing. */
export function cardSignalToneClass(tone: CardSignalTone): string {
  return tone === 'critical'
    ? 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40'
    : 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40';
}
