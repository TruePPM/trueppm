import { formatContainmentCount } from './containmentCount';

/**
 * Build the aria-live announcement fired when a summary task is
 * expanded or collapsed from the WBS column (#71).
 *
 * The count phrase comes from `formatContainmentCount`, not from a local
 * template: this used to say "N children visible" / bare "collapsed" while the
 * caret said "N inside" / "N hidden" and the design named only the latter, so
 * one fact had three vocabularies and the announced form disagreed with the
 * form on screen (#3025). A screen-reader user and a sighted user comparing
 * notes must be describing the same row.
 */
export function formatToggleAnnouncement(
  wasExpanded: boolean,
  name: string,
  childCount: number,
): string {
  const label = name || 'Summary';
  const verb = wasExpanded ? 'collapsed' : 'expanded';
  // `wasExpanded` is the state BEFORE the toggle, so the row is now the
  // opposite — and the count phrase describes where the children ended up.
  const count = formatContainmentCount(childCount, !wasExpanded);
  return count ? `${label} ${verb}, ${count}.` : `${label} ${verb}.`;
}
