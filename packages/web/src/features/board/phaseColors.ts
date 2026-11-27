import { PHASE_SWATCHES } from '@/lib/identityColors';

/** Return a stable color from the shared phase palette for a given phase ID or name. */
export function phaseColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return PHASE_SWATCHES[hash % PHASE_SWATCHES.length].value;
}
