/**
 * All-or-none three-point (PERT) estimate classification, shared by every create
 * surface (task form, paste-many) so they refuse the same states the server does:
 * the Monte Carlo sampler only draws from a COMPLETE, ORDERED triple
 * (optimistic <= most likely <= pessimistic), so a partial or unordered one must be
 * refused or dropped rather than sent.
 */
export type PertTripleState =
  | { kind: 'none' }
  | { kind: 'incomplete' }
  | { kind: 'out_of_order' }
  | { kind: 'ok'; o: number; m: number; p: number };

/**
 * Classify a parsed triple. `null` means the cell was blank; `NaN` means it held
 * something unparseable or negative — which counts as present-but-unusable, so it
 * reads `incomplete` rather than silently looking like "no estimate".
 */
export function classifyPertTriple(
  o: number | null,
  m: number | null,
  p: number | null,
): PertTripleState {
  if (o === null && m === null && p === null) return { kind: 'none' };
  if (o === null || m === null || p === null || Number.isNaN(o + m + p)) {
    return { kind: 'incomplete' };
  }
  return o <= m && m <= p ? { kind: 'ok', o, m, p } : { kind: 'out_of_order' };
}

/** Parse a number-input string: blank -> null, invalid or negative -> NaN. */
export function parsePertInput(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}
