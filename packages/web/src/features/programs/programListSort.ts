import type { Program, ProgramHealth } from '@/api/types';
import type { MethodologyFilterValue } from './MethodologyFilter';

/**
 * Sort keys for the /programs directory (issue #1796). Each is backed by a real
 * `Program` field so the visible order always maps to data the card shows:
 *  - `recent`  → `updated_at` descending ("recently active")
 *  - `name`    → `name` A→Z (locale-aware)
 *  - `health`  → PM health worst-first (Critical → At risk → On track → Auto)
 */
export type ProgramSortKey = 'recent' | 'name' | 'health';

export const PROGRAM_SORT_OPTIONS: ReadonlyArray<{ value: ProgramSortKey; label: string }> = [
  { value: 'recent', label: 'Recently active' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'health', label: 'Health (worst first)' },
];

/** Deliberate default: recently active. Pinned programs float to the top of
 *  every sort (see {@link filterAndSortPrograms}) so the default reads as
 *  "pinned first, then recent activity" — the visible default the header labels. */
export const DEFAULT_PROGRAM_SORT: ProgramSortKey = 'recent';

const SORT_PREF_KEY = 'trueppm.programs.sort';

/** Worst-first rank for the health sort. AUTO defers to the rollup and carries no
 *  per-card health, so it sorts last. */
const HEALTH_RANK: Record<ProgramHealth, number> = {
  CRITICAL: 3,
  AT_RISK: 2,
  ON_TRACK: 1,
  AUTO: 0,
};

function isProgramSortKey(v: unknown): v is ProgramSortKey {
  return v === 'recent' || v === 'name' || v === 'health';
}

/** Read the persisted per-browser sort preference, defaulting to `recent`.
 *  Reads defensively (private mode / SSR) like the rail prefs in shellStore. */
export function readProgramSortPref(): ProgramSortKey {
  try {
    const raw = localStorage.getItem(SORT_PREF_KEY);
    return isProgramSortKey(raw) ? raw : DEFAULT_PROGRAM_SORT;
  } catch {
    return DEFAULT_PROGRAM_SORT;
  }
}

/** Persist the per-browser sort preference. No-op when localStorage is unavailable. */
export function writeProgramSortPref(key: ProgramSortKey): void {
  try {
    localStorage.setItem(SORT_PREF_KEY, key);
  } catch {
    // localStorage unavailable — keep the in-memory value only.
  }
}

/** Case-insensitive substring match across the fields a user scans by: the
 *  program name, its short code, and its description. */
function matchesQuery(program: Program, needle: string): boolean {
  const haystack = `${program.name} ${program.code} ${program.description}`.toLowerCase();
  return haystack.includes(needle);
}

export interface ProgramFilterSortOptions {
  /** Free-text name/code/description filter. Trimmed + lower-cased internally. */
  query: string;
  /** Methodology facet; `'ALL'` disables the facet. Matches `program.methodology`
   *  (the value the card badge displays). */
  methodology: MethodologyFilterValue;
  sortKey: ProgramSortKey;
  /** Pinned program ids (client-side, from shellStore) — floated to the top of
   *  every sort so a pin stays a durable wayfinding anchor. */
  pinnedIds: readonly string[];
}

/**
 * Pure filter + sort for the /programs directory. Operates over the already-fetched
 * `Program[]` (the list is small and fully client-side — no server pagination), so
 * this is the single source of truth for both the rendered order and the vitest
 * coverage. Stable: ties fall back to name so the order never jitters between renders.
 */
export function filterAndSortPrograms(
  programs: readonly Program[],
  { query, methodology, sortKey, pinnedIds }: ProgramFilterSortOptions,
): Program[] {
  const needle = query.trim().toLowerCase();
  const pinned = new Set(pinnedIds);

  const filtered = programs.filter((p) => {
    if (needle && !matchesQuery(p, needle)) return false;
    if (methodology !== 'ALL' && p.methodology !== methodology) return false;
    return true;
  });

  const byName = (a: Program, b: Program) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  return [...filtered].sort((a, b) => {
    // Pinned programs float to the top of every sort.
    const aPinned = pinned.has(a.id) ? 1 : 0;
    const bPinned = pinned.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    switch (sortKey) {
      case 'name':
        return byName(a, b);
      case 'health': {
        const rank = HEALTH_RANK[b.health] - HEALTH_RANK[a.health];
        return rank !== 0 ? rank : byName(a, b);
      }
      case 'recent':
      default: {
        // updated_at is an ISO 8601 string; lexical compare is chronological.
        const recent = b.updated_at.localeCompare(a.updated_at);
        return recent !== 0 ? recent : byName(a, b);
      }
    }
  });
}
