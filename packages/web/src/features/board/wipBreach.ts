import type { TaskStatus } from '@/types';

/** WIP-limit breach details for a pending move, or `null` when the destination
 *  is under its limit (or has none configured). */
export interface WipBreach {
  label: string;
  count: number;
  limit: number;
}

/**
 * Compute whether moving one card into `newStatus` would push that column past
 * its WIP limit (#232). Returns the breach details (column label + current
 * count + limit) to feed the confirm dialog, or ``null`` when the move is under
 * the limit or the column has no limit.
 *
 * Replaces the old ``confirmWipMove`` native ``window.confirm`` (#2050): the
 * caller now defers the move behind a styled ``role="alertdialog"`` instead of a
 * browser-chrome prompt fired mid-drop.
 */
export function wipBreachInfo(
  columns: { status: TaskStatus; label: string; wipLimit: number | null }[],
  countByStatus: Record<string, number>,
  newStatus: TaskStatus,
): WipBreach | null {
  const col = columns.find((c) => c.status === newStatus);
  const limit = col?.wipLimit;
  if (!limit) return null;
  const count = countByStatus[newStatus] ?? 0;
  if (count + 1 <= limit) return null;
  return { label: col?.label ?? newStatus, count, limit };
}
