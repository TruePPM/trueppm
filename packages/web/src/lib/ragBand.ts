import { HEALTH_BAND_LABEL, type HealthBand } from '@/lib/healthBand';

/**
 * A project manager's own call on a status update (#4803): the API stores
 * `green` / `amber` / `red`. The product has ONE status vocabulary (rule 397), so a call is printed with the health band's word and glyph, never a
 * second set of words: green reads "On track", amber "At risk", red "Critical".
 * The map is the only place the two key shapes meet.
 */
export type Rag = 'green' | 'amber' | 'red';

/** In the order the radio group offers them. */
export const RAGS: readonly Rag[] = ['green', 'amber', 'red'];

export const RAG_BAND: Record<Rag, HealthBand> = {
  green: 'on_track',
  amber: 'at_risk',
  red: 'critical',
};

/** The word a call is printed with: the band word, from the one source. */
export function ragLabel(rag: Rag): string {
  return HEALTH_BAND_LABEL[RAG_BAND[rag]];
}

/** Narrow an API string to a band the vocabulary knows; anything else is not a band. */
export function asHealthBand(value: string | null | undefined): HealthBand | null {
  return value === 'on_track' || value === 'at_risk' || value === 'critical' ? value : null;
}
