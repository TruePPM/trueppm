import type { RelationType } from '@/types';

/**
 * Which end of a relation the viewer's task sits on. `outgoing` = the task is
 * the `source` (forward label); `incoming` = the task is the `target` (inverse
 * label). Relative task links (#2068).
 */
export type RelationDirection = 'outgoing' | 'incoming';

/** Forward (source→target) heading for each relation type. */
const FORWARD_LABEL: Record<RelationType, string> = {
  relates_to: 'Relates to',
  blocks: 'Blocks',
  duplicates: 'Duplicates',
};

/** Inverse (target←source) heading. `relates_to` is symmetric, so it is
 *  identical in both directions; `blocks`/`duplicates` flip. */
const INVERSE_LABEL: Record<RelationType, string> = {
  relates_to: 'Relates to',
  blocks: 'Blocked by',
  duplicates: 'Duplicated by',
};

/**
 * Human heading for a relation as seen from one end. The forward label reads
 * "Blocks" / "Duplicates"; the inverse reads "Blocked by" / "Duplicated by".
 * `relates_to` is symmetric and reads "Relates to" either way.
 */
export function relationLabel(type: RelationType, direction: RelationDirection): string {
  return direction === 'outgoing' ? FORWARD_LABEL[type] : INVERSE_LABEL[type];
}

/**
 * The forward label used when CREATING a relation from the viewer's task (which
 * is always the `source`). Drives the relation-type `<select>` in the picker.
 */
export function forwardRelationLabel(type: RelationType): string {
  return FORWARD_LABEL[type];
}

/**
 * Canonical display order for the grouped headings in the section. Keeps a
 * stable, predictable rendering regardless of the order relations come back in.
 */
export const RELATION_HEADING_ORDER: readonly string[] = [
  'Relates to',
  'Blocks',
  'Blocked by',
  'Duplicates',
  'Duplicated by',
];
