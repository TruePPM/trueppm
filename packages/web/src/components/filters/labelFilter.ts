/**
 * Shared label-filter primitives for every view that offers a Label facet
 * (Board, Table/Grid, Product Backlog, and — once #2384 lands — the Schedule).
 * ADR-0620, issue #2383.
 *
 * Three things live here so the four surfaces cannot drift apart:
 *
 * 1. {@link LABEL_PARAM} — the single definition of the `?fl=` query key. The
 *    Board shipped it first (`boardFacets.ts`, ADR-0199); every later view adopts
 *    it *verbatim* rather than inventing `?labels=`/`?label=`, so one bookmark
 *    format works everywhere and a ⌘K deep-link (#2334) has one target to build.
 * 2. {@link taskMatchesLabels} — OR *within* the facet (a task matches if it
 *    carries any selected label), which callers then AND with their other facets.
 *    Matching is by label **id**, never name: renaming a label must not silently
 *    break a saved view or a shared URL.
 * 3. {@link countTasksByLabel} — the per-option counts shown in the panel. These
 *    are computed over the rows the view has **already loaded**, not read from
 *    the catalog's server-side `taskCount`, for two reasons: filtering itself is
 *    client-side (ADR-0620 decision 3), and the count has to answer the question
 *    the user is actually asking — "how many rows *here* would this keep" — so a
 *    `0` next to a label that exists project-wide is correct and informative.
 */

import { parseIdList, serializeIdList } from './facetParams';
import type { Task, TaskLabel } from '@/types';

/**
 * Query-string key for the label facet, shared by every view.
 *
 * Value is a comma-separated list of label **ids**. Kept here (not in any one
 * view's facet module) so adding a fifth surface cannot fork the param name.
 */
export const LABEL_PARAM = 'fl';

/** Any row shape that can carry labels — `Task` satisfies it; so do test doubles. */
type LabelBearing = Pick<Task, 'labels'> | { labels?: TaskLabel[] };

/**
 * Parse a `?fl=` value into label ids, dropping blanks and duplicates while
 * preserving first-seen order (so the chip strip is stable across a reload).
 */
export function parseLabelIds(raw: string | null | undefined): string[] {
  return parseIdList(raw);
}

/** Serialize label ids for `?fl=`. An empty selection yields `''` so the caller
 *  drops the key entirely and an unfiltered view keeps a clean URL. */
export function serializeLabelIds(ids: string[]): string {
  return serializeIdList(ids);
}

/**
 * OR-within-facet match: does this row carry *any* of the selected labels?
 *
 * An empty selection matches everything (the facet is off). A row whose `labels`
 * is `undefined` — the payloads that omit the field, not the rows that have none
 * — cannot match a label, which is the safe direction: it is excluded from a
 * positive filter rather than smuggled in.
 */
export function taskMatchesLabels(task: LabelBearing, selected: string[]): boolean {
  if (selected.length === 0) return true;
  const ids = task.labels;
  if (!ids || ids.length === 0) return false;
  return ids.some((l) => selected.includes(l.id));
}

/**
 * Count how many of `tasks` carry each label id, over the rows already loaded.
 *
 * Every id in `catalogIds` gets an entry — including the ones that appear on no
 * loaded row, which is what lets the panel render a visible `0` *before* the
 * user picks. That is the whole point of decision 2: a zero-result selection
 * becomes a deliberate act instead of a dead end.
 */
export function countTasksByLabel(
  tasks: readonly LabelBearing[],
  catalogIds: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of catalogIds) counts[id] = 0;
  for (const task of tasks) {
    for (const label of task.labels ?? []) {
      if (label.id in counts) counts[label.id] += 1;
    }
  }
  return counts;
}

/**
 * Drop ids that are no longer in the catalog — a label deleted while a URL or a
 * restored session still names it.
 *
 * Views use this to keep the *applied* filter honest. It deliberately does not
 * try to repair anything: saved views need the dangling id preserved so they can
 * show the deleted-label tombstone and offer a fix (#2385), so pruning happens
 * at the point of application, never in storage.
 */
export function pruneUnknownLabelIds(
  ids: readonly string[],
  catalogIds: readonly string[],
): string[] {
  const known = new Set(catalogIds);
  return ids.filter((id) => known.has(id));
}
