/** Deterministic per-phase color rail palette. */
const RAIL_PALETTE = [
  '#3E8C6D', // brand-primary
  '#E8A020', // brand-accent
  '#3B82F6', // blue-500
  '#8B5CF6', // violet-500
  '#EC4899', // pink-500
  '#14B8A6', // teal-500
  '#F97316', // orange-500
  '#64748B', // slate-500
] as const;

/** Return a stable color from the palette for a given phase ID or name. */
export function phaseColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash * 31) + id.charCodeAt(i)) >>> 0;
  }
  return RAIL_PALETTE[hash % RAIL_PALETTE.length];
}
