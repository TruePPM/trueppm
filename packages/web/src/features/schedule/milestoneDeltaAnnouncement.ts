import type { PreviewMilestone } from '@/workers/cpmWorker.types';

/**
 * The screen-reader announcement for the milestone a drag moves furthest.
 *
 * Shared by `useDragCpm` and `useKeyboardReschedule`, which post the identical
 * string to the same aria-live region from two copies of the same three-line
 * ternary (rule 30). One home so the mouse and keyboard paths cannot drift.
 *
 * `PreviewOverlay` and `MilestoneDeltaTooltip` are `aria-hidden`, so this is the
 * only channel that reaches a screen reader at all.
 *
 * The `deltaDays < 0` branch exists because issue #3535 made a negative delta
 * REACHABLE: the preview now relaxes in both directions and reports the
 * milestone that moves furthest by magnitude, so a drag that pulls work in
 * produces the improvement it always should have. The prior two-branch form
 * announced every one of those as "on schedule" — the milestone had in fact
 * moved a week, in the user's favor, on the one gesture whose purpose is to
 * move it.
 */
export function milestoneDeltaAnnouncement(milestone: PreviewMilestone): string {
  const { name, deltaDays } = milestone;
  if (deltaDays === 0) return `${name} on schedule`;
  const magnitude = Math.abs(deltaDays);
  const unit = `day${magnitude === 1 ? '' : 's'}`;
  return deltaDays > 0
    ? `${name} slips ${magnitude} ${unit}`
    : `${name} moves ${magnitude} ${unit} earlier`;
}
