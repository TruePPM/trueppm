import type { Risk } from '@/api/types';

/**
 * Risk register facet filtering and severity sort.
 *
 * Pure helpers so the segment/sort logic is unit-testable in isolation from the
 * view. The register composes two orthogonal facets — the segment filter below
 * and the P×I matrix-cell filter — with AND; this module owns only the segment
 * facet and the severity sort. Both operate client-side over the already-loaded
 * risk list (no API round-trip), which is why the whole slice is frontend-only.
 */

export type RiskFilter = 'all' | 'high' | 'unmitigated' | 'mine';

export const RISK_FILTERS: { value: RiskFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'high', label: 'High' },
  { value: 'unmitigated', label: 'Unmitigated' },
  { value: 'mine', label: 'Mine' },
];

/**
 * Severity threshold for the "High" segment. Inclusive of critical (>= 20), so
 * "High" reads as "high and above" — deliberately a superset of the read-only
 * "{n} high" header chip (which is 12–19, exclusive of critical) so the two
 * affordances don't appear to disagree.
 */
export const HIGH_SEVERITY_THRESHOLD = 12;

/**
 * A risk is "unmitigated" while it is still an active, undecided threat — OPEN
 * or actively MITIGATING. RESOLVED / ACCEPTED / CLOSED are handled outcomes
 * (ACCEPTED is a deliberate decision, so it counts as handled). The predicate
 * keys off the lifecycle `status`, not `response`: a response *strategy* can be
 * chosen long before the risk is actually handled. Drives both the
 * "Unmitigated" segment and the always-on row highlight.
 */
export function isUnmitigated(risk: Risk): boolean {
  return risk.status === 'OPEN' || risk.status === 'MITIGATING';
}

/**
 * Predicate for the active segment facet. `currentUserId` resolves "Mine"; when
 * it is null (identity not loaded) "Mine" matches nothing rather than throwing,
 * so an unauthenticated/loading state degrades to an empty list + empty state.
 */
export function matchesRiskFilter(
  risk: Risk,
  filter: RiskFilter,
  currentUserId: string | null,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'high':
      return risk.severity >= HIGH_SEVERITY_THRESHOLD;
    case 'unmitigated':
      return isUnmitigated(risk);
    case 'mine':
      return currentUserId != null && risk.owner === currentUserId;
  }
}

export type SeveritySort = 'none' | 'desc' | 'asc';

/** Cycle order for the sortable Severity header: none → desc → asc → none. */
export function nextSeveritySort(current: SeveritySort): SeveritySort {
  if (current === 'none') return 'desc';
  if (current === 'desc') return 'asc';
  return 'none';
}

/** Maps the sort state to an `aria-sort` token for the column header. */
export function severityAriaSort(sort: SeveritySort): 'none' | 'ascending' | 'descending' {
  if (sort === 'desc') return 'descending';
  if (sort === 'asc') return 'ascending';
  return 'none';
}

/**
 * Stable severity sort applied *after* filtering. `'none'` returns the input
 * order untouched (the server's default `-impact, -probability, title`
 * ordering). Never mutates the input array.
 */
export function sortRisksBySeverity<T extends Pick<Risk, 'severity'>>(
  risks: T[],
  sort: SeveritySort,
): T[] {
  if (sort === 'none') return risks;
  const sign = sort === 'desc' ? -1 : 1;
  return [...risks].sort((a, b) => sign * (a.severity - b.severity));
}

/**
 * "Newest" sort (issue 1230) — most recently created risk first, by `created_at`
 * ISO string (lexicographic order matches chronological order for ISO-8601).
 * Never mutates the input array. Mutually exclusive with the severity sort in
 * the view: only one ordering is active at a time.
 */
export function sortRisksByNewest<T extends Pick<Risk, 'created_at'>>(risks: T[]): T[] {
  return [...risks].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Live per-facet counts over the full loaded list (issue 1230), so each segment
 * chip can preview how many risks it would show without the user selecting it.
 * Computed over the unfiltered list — the chips describe the whole register, not
 * the currently narrowed table.
 */
export function riskFilterCounts(
  risks: Risk[],
  currentUserId: string | null,
): Record<RiskFilter, number> {
  const counts: Record<RiskFilter, number> = { all: 0, high: 0, unmitigated: 0, mine: 0 };
  for (const r of risks) {
    for (const f of RISK_FILTERS) {
      if (matchesRiskFilter(r, f.value, currentUserId)) counts[f.value] += 1;
    }
  }
  return counts;
}
