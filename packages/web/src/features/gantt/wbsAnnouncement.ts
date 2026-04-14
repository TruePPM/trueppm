/**
 * Build the aria-live announcement fired when a summary task is
 * expanded or collapsed from the WBS column (#71).
 */
export function formatToggleAnnouncement(
  wasExpanded: boolean,
  name: string,
  childCount: number,
): string {
  const label = name || 'Summary';
  if (wasExpanded) return `${label} collapsed.`;
  const noun = childCount === 1 ? 'child' : 'children';
  return `${label} expanded, ${childCount} ${noun} visible.`;
}
