/**
 * Pure grooming-filter helpers for the Product-Owner backlog (issue 1044).
 *
 * Kept free of React so the combine-filters logic — the part most likely to
 * regress — is unit-tested in isolation, mirroring the program backlog's
 * `filter.ts` and the ADR-0199 board-facet convention (a pure predicate module
 * owns the filter type and all matching). The grooming view filters `Task`
 * stories by their Definition-of-Ready state and estimate, not the program
 * backlog's status/type/tags, so this is a distinct predicate set rather than a
 * cross-feature import.
 *
 * Remove semantics (ADR-0199): a non-matching story is dropped from the rendered
 * list, not dimmed — the grooming table is dense and a dimmed row would still
 * cost the vertical scan the filter exists to shorten.
 */

import type { DorState, Task } from '@/types';
import type { ProductBacklog } from './types';

export interface GroomingFilters {
  /** Title-contains search; blank = match all. */
  query: string;
  /** Multi-select DoR facet (OR); empty = any readiness. */
  dorStates: DorState[];
  /** When true, keep only stories with no story-point estimate. */
  unestimatedOnly: boolean;
}

export const EMPTY_GROOMING_FILTERS: GroomingFilters = {
  query: '',
  dorStates: [],
  unestimatedOnly: false,
};

/** Lowercase + strip diacritics so "Pólaris" matches "polaris". */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Title-only substring match on a story's name, case- and accent-insensitive. */
export function matchesStorySearch(story: Task, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  return normalize(story.name).includes(q);
}

/** A story with no story-point estimate (the grooming "needs an estimate" cohort). */
export function isUnestimated(story: Task): boolean {
  return story.storyPoints == null;
}

/** True when the story satisfies all active facets AND the search query. */
export function matchesFilters(story: Task, filters: GroomingFilters): boolean {
  if (filters.unestimatedOnly && !isUnestimated(story)) return false;
  if (filters.dorStates.length > 0 && !filters.dorStates.includes(story.dor ?? 'idea')) {
    return false;
  }
  return matchesStorySearch(story, filters.query);
}

/** Filter a flat story list — used by the ranked view and each epic group. */
export function filterStories(stories: Task[], filters: GroomingFilters): Task[] {
  return stories.filter((s) => matchesFilters(s, filters));
}

/** True when any facet or the search query is engaged (drives the drag-disable + count). */
export function isFilterActive(filters: GroomingFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.dorStates.length > 0 ||
    filters.unestimatedOnly
  );
}

/** Total stories across every epic group + the ungrouped bucket (the count denominator). */
export function countStories(backlog: ProductBacklog): number {
  return backlog.epics.reduce((sum, g) => sum + g.stories.length, 0) + backlog.ungrouped.length;
}

/**
 * Apply the filters to a whole backlog, preserving the epic grouping.
 *
 * Epic groups that end up with zero matching stories are dropped (no empty
 * header renders); the ungrouped bucket is filtered in place. `matchCount` is
 * the total surviving stories — the numerator of the "N of M" toolbar readout.
 */
export function filterBacklog(
  backlog: ProductBacklog,
  filters: GroomingFilters,
): { epics: ProductBacklog['epics']; ungrouped: Task[]; matchCount: number } {
  const epics = backlog.epics
    .map((g) => ({ ...g, stories: filterStories(g.stories, filters) }))
    .filter((g) => g.stories.length > 0);
  const ungrouped = filterStories(backlog.ungrouped, filters);
  const matchCount = epics.reduce((sum, g) => sum + g.stories.length, 0) + ungrouped.length;
  return { epics, ungrouped, matchCount };
}
