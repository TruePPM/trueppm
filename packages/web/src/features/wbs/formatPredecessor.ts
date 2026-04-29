import type { LinkType } from '@/types';

export interface PredecessorSpec {
  wbs: string;
  type: LinkType;
  lagDays: number;
}

/**
 * Format a predecessor edge as WBS lag notation, e.g. "1.1.1 FS+10".
 * Lag of 0 is omitted. Negative lag is rendered as "-N".
 */
export function formatPredecessor({ wbs, type, lagDays }: PredecessorSpec): string {
  if (lagDays === 0) return `${wbs} ${type}`;
  const sign = lagDays > 0 ? '+' : '';
  return `${wbs} ${type}${sign}${lagDays}`;
}

/** Format a list of predecessors as a comma-separated string. */
export function formatPredecessors(preds: PredecessorSpec[]): string {
  return preds.map(formatPredecessor).join(', ');
}
