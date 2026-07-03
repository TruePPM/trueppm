import type { DurationChangePercentPolicy } from '@/api/types';

/**
 * Local state for one pending inline "Recalc %?" prompt (ADR-0151, issue 1254).
 * Surfaced entirely client-side by the editing row — the server never mutates %
 * under the `confirm` policy, so the opt-in re-estimate is a follow-up PATCH the
 * client issues only if the user accepts.
 */
export interface RecalcPromptState {
  taskId: string;
  oldDuration: number;
  newDuration: number;
  oldPercent: number;
  /** The proration the row offers — matches what the server's `prorate` policy would compute. */
  suggestedPercent: number;
}

/** ~10s auto-dismiss window for the inline prompt (ADR-0151, deliberately no countdown). */
export const RECALC_PROMPT_TIMEOUT_MS = 10_000;

/**
 * Prorated percent = round(oldPct * oldDur / newDur, 1), clamped to [0, 100].
 * Mirrors the server-side `prorate` math (ADR-0151 §4) so an opt-in "confirm"
 * proration lands on exactly the value the `prorate` policy would have written.
 */
export function proratedPercent(
  oldPercent: number,
  oldDuration: number,
  newDuration: number,
): number {
  if (newDuration <= 0) return oldPercent;
  const raw = Math.round(((oldPercent * oldDuration) / newDuration) * 10) / 10;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Whether a committed duration edit should raise the inline "Recalc %?" prompt.
 *
 * Only under the effective `confirm` policy, only when the task already has
 * progress, only when the duration actually changed to a positive value, and
 * never when suppressed (coarse-pointer / mobile — ADR-0151 treats `confirm` as
 * `keep` there). The CPM cascade never reaches this path (it moves dates, not
 * durations), so a cascade can never prompt (ADR-0151 §5).
 */
export function shouldPromptRecalc(args: {
  policy: DurationChangePercentPolicy;
  oldPercent: number;
  oldDuration: number;
  newDuration: number;
  suppressed: boolean;
}): boolean {
  const { policy, oldPercent, oldDuration, newDuration, suppressed } = args;
  if (suppressed) return false;
  if (policy !== 'confirm') return false;
  if (oldPercent <= 0) return false;
  if (newDuration <= 0) return false;
  if (newDuration === oldDuration) return false;
  return true;
}

/** Build the prompt state for a qualifying edit, or `null` when it doesn't qualify. */
export function buildRecalcPrompt(args: {
  taskId: string;
  policy: DurationChangePercentPolicy;
  oldPercent: number;
  oldDuration: number;
  newDuration: number;
  suppressed: boolean;
}): RecalcPromptState | null {
  if (!shouldPromptRecalc(args)) return null;
  return {
    taskId: args.taskId,
    oldDuration: args.oldDuration,
    newDuration: args.newDuration,
    oldPercent: args.oldPercent,
    suggestedPercent: proratedPercent(args.oldPercent, args.oldDuration, args.newDuration),
  };
}
