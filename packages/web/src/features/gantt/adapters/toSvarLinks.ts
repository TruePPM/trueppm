import type { TaskLink, LinkType } from '@/types';
import type { ILink } from '@svar-ui/gantt-store';

// TLinkType = "s2s" | "s2e" | "e2s" | "e2e" (defined internally in @svar-ui/gantt-store)
type SvarLinkType = 's2s' | 's2e' | 'e2s' | 'e2e';

// TruePPM standard → SVAR internal notation
const LINK_TYPE_MAP: Record<LinkType, SvarLinkType> = {
  FS: 'e2s', // Finish-to-Start
  SS: 's2s', // Start-to-Start
  FF: 'e2e', // Finish-to-Finish
  SF: 's2e', // Start-to-Finish
};

/**
 * Maps a TruePPM TaskLink to SVAR's ILink shape.
 *
 * $critical is a custom field consumed by gantt.css to style critical dependency
 * arrows in Red 400 (#F87171) at 1.5px width (Design System v1.0 §2.2).
 */
export function toSvarLink(link: TaskLink): ILink & { $critical: boolean } {
  return {
    id: link.id,
    source: link.sourceId,
    target: link.targetId,
    type: LINK_TYPE_MAP[link.type] as ILink['type'],
    $critical: link.isCritical,
  };
}

export function toSvarLinks(links: TaskLink[]): Array<ILink & { $critical: boolean }> {
  return links.map(toSvarLink);
}
