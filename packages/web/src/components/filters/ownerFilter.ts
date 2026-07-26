/**
 * Owner-facet primitives: the predicate, the counts, and the grouped option
 * list. ADR-0624, issue #2387.
 *
 * The Owner facet's catalog is the **project's resource pool**, not the set of
 * assignees present on the loaded rows. Same contract as Label (ADR-0620
 * decision 2): you must be able to see "Ferreira has nothing here" without
 * selecting them to find out. The design splits that catalog into two groups —
 * `On these rows` (people with at least one match, most first) then
 * `All members` — so a 43-person roster still puts the useful half at the top.
 */

import type { Task, TaskAssignee } from '@/types';

/** A person who can own work on this project. */
export interface OwnerCandidate {
  /** Resource id — what goes in `?owner=`. */
  id: string;
  name: string;
}

/** Any row shape carrying assignees — `Task` satisfies it, so do test doubles. */
type OwnerBearing = Pick<Task, 'assignees'> | { assignees?: TaskAssignee[] };

/**
 * OR *within* the facet: a task matches if **any** of its assignees is selected.
 * Callers AND this with their other facets.
 *
 * Matching accepts a resource **id or name**, deliberately. The facet emits ids
 * (renaming a resource must not break a shared link, the trap ADR-0620 avoided
 * for labels), but `?owner=` shipped as a *name* match and hand-built or
 * bookmarked links carrying `?owner=Alice%20Smith` still exist in the wild.
 * Accepting both keeps every one of them resolving while new links are id-based.
 */
export function taskMatchesOwners(task: OwnerBearing, selected: string[]): boolean {
  if (selected.length === 0) return true;
  const assignees = task.assignees;
  if (!assignees || assignees.length === 0) return false;
  return assignees.some((a) => selected.includes(a.resourceId) || selected.includes(a.name));
}

/**
 * Per-owner match counts over the rows the view has already loaded, seeded with
 * `0` for every roster member so a person with nothing here still renders a
 * truthful zero rather than vanishing from the list.
 */
export function countTasksByOwner(
  tasks: OwnerBearing[],
  candidateIds: string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of candidateIds) counts[id] = 0;
  for (const task of tasks) {
    // A task assigned to two people counts once for each — the number answers
    // "how many rows would this option keep", and both options would keep it.
    for (const assignee of task.assignees ?? []) {
      if (assignee.resourceId in counts) counts[assignee.resourceId] += 1;
    }
  }
  return counts;
}

export interface OwnerGrouping {
  /** Roster members with at least one matching row, most matches first. */
  onTheseRows: OwnerCandidate[];
  /** Everyone else, alphabetical — the long tail of a large roster. */
  allMembers: OwnerCandidate[];
}

/**
 * Split the roster into the design's two groups. Ties inside `On these rows`
 * fall back to name so the order is stable between renders (a list that
 * reshuffles under the cursor is worse than one that is merely long).
 */
export function groupOwnerCandidates(
  candidates: OwnerCandidate[],
  counts: Record<string, number>,
): OwnerGrouping {
  const byName = (a: OwnerCandidate, b: OwnerCandidate) => a.name.localeCompare(b.name);
  const onTheseRows = candidates
    .filter((c) => (counts[c.id] ?? 0) > 0)
    .sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || byName(a, b));
  const allMembers = candidates.filter((c) => (counts[c.id] ?? 0) === 0).sort(byName);
  return { onTheseRows, allMembers };
}

/**
 * Names for the trigger and the chip strip, resolved from ids. A selected id
 * with no roster entry (a resource removed from the project while a link still
 * names them) falls back to the raw value rather than rendering a nameless
 * chip — the filter is still applied, so hiding it would be a lie.
 */
export function ownerDisplayName(id: string, candidates: OwnerCandidate[]): string {
  return candidates.find((c) => c.id === id)?.name ?? id;
}
