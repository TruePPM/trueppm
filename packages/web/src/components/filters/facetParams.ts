/**
 * Query-string primitives shared by every multi-select facet (Owner, Status,
 * Label). ADR-0624, issue #2387.
 *
 * One parser and one serializer, so the three facets cannot drift into three
 * subtly different list formats. The format is deliberately the one `?fl=`
 * shipped with in ADR-0620: a comma-separated list of opaque ids.
 *
 * Why that matters for backward compatibility: a **one-value param is just a
 * one-item list**. Every `?owner=Alice&status=IN_PROGRESS` link that worked
 * against the old single-value fields parses to `['Alice']` / `['IN_PROGRESS']`
 * and resolves exactly as before — no redirect, no migration notice, no
 * "your link is out of date" state to design.
 */

/** Query key for the Owner facet. Comma-separated resource ids (or names — see
 *  `taskMatchesOwners` for why both are accepted). */
export const OWNER_PARAM = 'owner';

/** Query key for the Status facet. Comma-separated `TaskStatus` values. */
export const STATUS_PARAM = 'status';

/**
 * Parse a comma-separated param value into ids, dropping blanks and duplicates
 * while preserving first-seen order — so the chip strip renders in the order
 * the user picked and stays stable across a reload.
 */
export function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Serialize ids back into a param value. An empty selection yields `''` so the
 * caller drops the key entirely and an unfiltered view keeps a clean URL.
 */
export function serializeIdList(ids: string[]): string {
  return ids.join(',');
}
