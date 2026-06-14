/**
 * Structured-blocker shared constants + formatters (ADR-0124, #1135).
 *
 * `blocker_type` is the team-shareable triage signal — the *type* classifies the
 * impediment so it can be routed ("3 waiting on a vendor → one call"). The
 * free-text `blocked_reason` is private to the assignee + @-mentioned and is
 * served by the API only to those parties (absent from the payload otherwise),
 * so the web never needs to gate it client-side — it simply renders the reason
 * when present and the structured type/age always.
 */

/** The five structured blocker classifications (mirrors `BlockerType` on the API). */
export type BlockerType = 'dependency' | 'resource' | 'vendor' | 'decision' | 'other';

/** Ordered list for the picker (excludes the "none" sentinel, rendered separately). */
export const BLOCKER_TYPES: readonly BlockerType[] = [
  'dependency',
  'resource',
  'vendor',
  'decision',
  'other',
] as const;

/** Human labels — must match the API `BlockerType` choice labels exactly. */
export const BLOCKER_TYPE_LABEL: Record<BlockerType, string> = {
  dependency: 'Waiting on dependency',
  resource: 'Missing resource',
  vendor: 'External vendor',
  decision: 'Decision needed',
  other: 'Other',
};

/**
 * Format a blocked age (whole seconds) as a coarse "Xd Yh" / "Xh" / "just now"
 * label for the blocked badge. Coarse by design — the badge signals escalation
 * (how long it has been stuck), not minute-level precision, and a coarse label
 * avoids implying surveillance of exactly when a contributor flagged their work.
 * Returns null when the age is null (the task is not flagged blocked).
 */
export function formatBlockedAge(ageSeconds: number | null | undefined): string | null {
  if (ageSeconds == null) return null;
  const safe = Math.max(0, Math.floor(ageSeconds));
  const days = Math.floor(safe / 86400);
  const hours = Math.floor((safe % 86400) / 3600);
  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h blocked` : `${days}d blocked`;
  }
  if (hours >= 1) {
    return `${hours}h blocked`;
  }
  return 'just now';
}

/** Resolve a blocker-type label, falling back to the raw code for unknown values. */
export function blockerTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  return BLOCKER_TYPE_LABEL[type as BlockerType] ?? type;
}
