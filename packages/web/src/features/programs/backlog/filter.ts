/**
 * Pure backlog filtering, search, and sort helpers.
 *
 * Kept free of React so the combine-filters logic (the part most likely to
 * regress) is unit-tested in isolation. Per ADR-0069 the real trigram search
 * is server-side; until `#search` lands we approximate it here with an
 * accent-insensitive substring match on the title — same observable behavior
 * for the cases users hit, swappable later without touching callers.
 */

import { normalizeForSearch } from '@/lib/searchHighlight';
import type { BacklogItem, BacklogItemStatus, BacklogItemType } from './types';

export interface BacklogFilters {
  query: string;
  /** Single-select status chip; `null` = "All". */
  status: BacklogItemStatus | null;
  /** Multi-select type facet; empty = any. */
  types: BacklogItemType[];
  /** Multi-select tag facet (AND); empty = any. */
  tags: string[];
}

/**
 * Lowercase + strip diacritics so "Polaris" matches "Pólaris".
 *
 * The comparison form is shared with every other search surface
 * (`@/lib/searchHighlight`) rather than re-derived here: the highlighter that
 * marks a hit has to agree with the filter that produced the row, or a row
 * arrives with nothing marked in it.
 */
export const normalize = normalizeForSearch;

/** Title-only substring match, case- and accent-insensitive. */
export function matchesSearch(item: BacklogItem, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  return normalize(item.title).includes(q);
}

/**
 * Apply status + type + tag facets (AND) and the search query.
 *
 * "All" (status === null) hides ARCHIVED items — archived work is removed
 * from the default view and only reachable via the Archived chip (00-context).
 */
export function filterItems(items: BacklogItem[], filters: BacklogFilters): BacklogItem[] {
  const { status, types, tags, query } = filters;
  return items.filter((item) => {
    if (status === null) {
      if (item.status === 'ARCHIVED') return false;
    } else if (item.status !== status) {
      return false;
    }
    if (types.length > 0 && !types.includes(item.itemType)) return false;
    if (tags.length > 0 && !tags.every((t) => item.tags.includes(t))) return false;
    if (!matchesSearch(item, query)) return false;
    return true;
  });
}

/**
 * Sort by priorityRank ascending, then createdAt descending within a rank.
 *
 * `priorityRank` is nullable (#2668 — the server field is nullable and
 * nothing assigned a rank on create for a long time, so an all-null pool is a
 * real state, not just a transient one). A null coerces to `0` under bare
 * arithmetic, which silently sorted every unranked item *ahead* of every
 * ranked one — the toolbar's "Sorted by priority" label was vacuous on any
 * pool created through the UI. Null is treated as "lowest priority" instead:
 * it always sorts after a numeric rank, and two nulls fall back to the
 * createdAt tiebreak like any tied rank.
 */
export function sortItems(items: BacklogItem[]): BacklogItem[] {
  return [...items].sort((a, b) => {
    const ar = a.priorityRank;
    const br = b.priorityRank;
    if (ar !== br) {
      if (ar === null) return 1;
      if (br === null) return -1;
      return ar - br;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * Split the visible list into the main (PROPOSED, or the active filter) rows
 * and the collapsible Pulled section. PULLED rows are only pulled out into
 * their own section in the default "All" view; when a status chip is active
 * the user already sees a single-status list, so everything stays in `main`.
 */
export function splitPulled(
  items: BacklogItem[],
  status: BacklogItemStatus | null,
): { main: BacklogItem[]; pulled: BacklogItem[] } {
  if (status !== null) return { main: items, pulled: [] };
  const main: BacklogItem[] = [];
  const pulled: BacklogItem[] = [];
  for (const item of items) {
    (item.status === 'PULLED' ? pulled : main).push(item);
  }
  return { main, pulled };
}

export interface StatusCounts {
  all: number;
  proposed: number;
  pulled: number;
  archived: number;
}

/** Counts for the status chips — from a single pass over the full set. */
export function countByStatus(items: BacklogItem[]): StatusCounts {
  const counts: StatusCounts = { all: items.length, proposed: 0, pulled: 0, archived: 0 };
  for (const item of items) {
    if (item.status === 'PROPOSED') counts.proposed += 1;
    else if (item.status === 'PULLED') counts.pulled += 1;
    else if (item.status === 'ARCHIVED') counts.archived += 1;
  }
  return counts;
}

/** Distinct tags across the set, alphabetized — feeds the Tags facet menu. */
export function distinctTags(items: BacklogItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) for (const tag of item.tags) seen.add(tag);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Next priorityRank for a freshly created item (bottom of the list). Null
 * ranks (an item created before this was wired up, or never ranked) are
 * excluded from the max rather than coerced to 0, so one stray unranked item
 * can't drag every future create back down to rank 1.
 */
export function nextPriorityRank(items: BacklogItem[]): number {
  return (
    items.reduce(
      (max, item) => (item.priorityRank === null ? max : Math.max(max, item.priorityRank)),
      0,
    ) + 1
  );
}
