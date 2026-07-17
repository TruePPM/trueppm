import type { AgentAction, AgentActionRefusalReason, AgentActionVerdict } from '@/api/types';

/**
 * Verdict → display triple (#2020). A verdict is a *status* encoding mapped onto
 * the app's semantic tokens, and is NEVER color-alone (WCAG 1.4.1): each carries
 * a symbol + text label + color class. These are the same semantic tokens the
 * Monte Carlo rules use, so the whole Agents tab reads as one system.
 */
export interface VerdictDisplay {
  label: string;
  /** A leading glyph rendered aria-hidden beside the text label. */
  symbol: string;
  textClass: string;
}

export const VERDICT_DISPLAY: Record<AgentActionVerdict, VerdictDisplay> = {
  allowed: { label: 'Allowed', symbol: '●', textClass: 'text-semantic-on-track' },
  refused: { label: 'Refused', symbol: '⛔', textClass: 'text-semantic-critical' },
  // Reserved for the 0.7 approval gate; defined so the vocabulary is stable.
  requires_approval: {
    label: 'Requires approval',
    symbol: '◐',
    textClass: 'text-semantic-at-risk',
  },
};

/** The coarse refusal-reason axis (identity | policy). */
export const REASON_LABEL: Record<Exclude<AgentActionRefusalReason, ''>, string> = {
  identity: 'Identity',
  policy: 'Policy',
};

/** Distribution-bucket labels, including the forward-looking `commitment` bucket. */
export const GROUP_LABEL: Record<RefusalGroup, string> = {
  identity: 'Identity',
  policy: 'Policy',
  commitment: 'Commitment',
};

/**
 * A short, literal "why" string for a refusal, derived from the recorded reason
 * (+ capability). Kept plain and non-speculative — it restates what the chain
 * recorded, it does not infer. Commitment refusals (the 0.6 gated-write surface)
 * will carry a schedule reason on `refusal_detail.projected_impact`; until then
 * only identity/policy read-refusals exist.
 */
export function refusalWhy(action: AgentAction): string {
  if (action.refusal_reason === 'identity') return 'Token invalid or expired';
  if (action.refusal_reason === 'policy') {
    return action.capability_used ? `Missing ${action.capability_used} scope` : 'Capability denied';
  }
  return 'Refused';
}

export type RefusalGroup = 'identity' | 'policy' | 'commitment';

/**
 * Which distribution bucket a refusal falls into. `commitment` is the
 * forward-looking 0.6 bucket (a write rejected as schedule-infeasible); no
 * producer emits it today, so on the read surface every refusal is
 * identity/policy. A row with an unexpected reason is bucketed as `policy`
 * (the "actor known, action denied" catch-all) rather than dropped.
 */
export function refusalGroup(action: AgentAction): RefusalGroup {
  if (action.refusal_reason === 'identity') return 'identity';
  return 'policy';
}
