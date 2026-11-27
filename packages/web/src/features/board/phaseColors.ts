import { PHASE_SWATCHES } from '@/lib/identityColors';

/**
 * The rail's own fixed list, picked by name from the shared set. It is not the
 * whole set on purpose: hashing over `PHASE_SWATCHES` would recolor every rail
 * each time a swatch is appended, and a red (reads as critical) or a gray (reads
 * as inactive) must never be assigned to a phase by chance. Every pair is at
 * least 30 degrees apart in hue so neighboring phases do not look alike.
 */
const RAIL_NAMES: readonly (typeof PHASE_SWATCHES)[number]['name'][] = [
  'Sage',
  'Amber',
  'Violet',
  'Sky blue',
  'Lime',
  'Pink',
];

export const RAIL_PALETTE: readonly string[] = RAIL_NAMES.flatMap((name) =>
  PHASE_SWATCHES.filter((swatch) => swatch.name === name).map((swatch) => swatch.value),
);

/** Return a stable rail color for a given phase ID or name. */
export function phaseColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return RAIL_PALETTE[hash % RAIL_PALETTE.length];
}
