/**
 * Summarize a saved board view's filters for the views menu (#2394, frames D1–D2).
 *
 * The menu line answers "what does this view actually filter?" *before* you open
 * it — `Owner: 2 · Due: Overdue · ● Needs review` — so choosing a view is not a
 * guess followed by an undo.
 *
 * **Label names are resolved against the project's label catalog, never against
 * the labels present on the board's cards.** That distinction is the whole
 * correctness argument here: `collectLabelOptions` derives its id→name map from
 * the labels carried by *visible* cards, so a live label that no current card
 * happens to carry is indistinguishable from a deleted one — both come back
 * `undefined`. A tombstone built on that map would tell the user a label was
 * deleted when it is merely unused, which is worse than saying nothing.
 *
 * The catalog is project-scoped on the server (`LabelViewSet.get_queryset`
 * filters `project_id`), which is also what keeps this from becoming a
 * cross-project label-name oracle: a saved view can legitimately carry a label
 * id belonging to another project (#2385 stores ids without validating them),
 * and such an id is simply absent from this project's catalog. It resolves to
 * the same anonymous tombstone as a deleted one, leaking nothing about the
 * project that owns it.
 */
import type { Label } from '@/hooks/useLabels';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';
import { PRIORITY_BAND_LABEL, DUE_WINDOW_LABEL } from './boardFacets';

/**
 * One label referenced by a saved view.
 *
 * `name`/`color` are null when the id is not in this project's catalog — the
 * label was deleted, or the id belongs to another project. Those two cases are
 * deliberately indistinguishable to the client.
 */
export interface ViewLabelRef {
  id: string;
  name: string | null;
  color: string | null;
}

export interface SavedViewSummary {
  /** Non-label facet segments, already display-formatted and ordered. */
  segments: string[];
  labels: ViewLabelRef[];
  /** At least one referenced label is missing from the catalog. */
  hasMissingLabel: boolean;
  /** Nothing to summarize — the row renders no meta line at all. */
  isEmpty: boolean;
}

/**
 * Counts, not names, for owners.
 *
 * A view filtered to four people would otherwise wrap the menu row or truncate
 * mid-name; the count is the honest summary and the panel has the detail.
 * Priority and due windows are enumerated because their vocabularies are tiny
 * and fixed, so the words fit and carry more than a number would.
 */
export function summarizeSavedView(
  config: BoardViewConfig | undefined,
  catalog: Label[] | undefined,
): SavedViewSummary {
  const filters = config?.filters;
  const segments: string[] = [];

  const assigneeCount = filters?.assignees.length ?? 0;
  if (assigneeCount > 0) segments.push(`Owner: ${assigneeCount}`);

  const priority = filters?.priority ?? [];
  if (priority.length > 0) {
    segments.push(`Priority: ${priority.map((p) => PRIORITY_BAND_LABEL[p]).join(', ')}`);
  }

  const due = filters?.due ?? [];
  if (due.length > 0) {
    segments.push(`Due: ${due.map((d) => DUE_WINDOW_LABEL[d]).join(', ')}`);
  }

  // Non-facet toggles that materially change what the board shows. Sort order
  // and display toggles (tints, EVM, cost) are deliberately excluded: they do
  // not change *which* cards you see, and listing them would bury the filters
  // that do.
  if (config?.riskLinkedOnly) segments.push('Risk-linked');
  if (config?.cpOnly) segments.push('Critical path');
  if (config?.assigneeFilter === 'me') segments.push('My work');
  if (config?.dueSoonDays != null) segments.push(`Due in ${config.dueSoonDays}d`);

  const byId = new Map((catalog ?? []).map((l) => [l.id, l]));
  const labels: ViewLabelRef[] = (filters?.labels ?? []).map((id) => {
    const found = byId.get(id);
    return { id, name: found?.name ?? null, color: found?.color ?? null };
  });

  return {
    segments,
    labels,
    hasMissingLabel: labels.some((l) => l.name === null),
    isEmpty: segments.length === 0 && labels.length === 0,
  };
}

/**
 * The ids a view references that are no longer in the catalog.
 *
 * Returned as ids rather than a boolean because the repair flow removes exactly
 * these from the stored config — and only these, leaving every other filter the
 * user set untouched.
 */
export function missingLabelIds(
  config: BoardViewConfig | undefined,
  catalog: Label[] | undefined,
): string[] {
  // An unloaded catalog is not evidence of deletion. Returning ids here would
  // flash a "this label was deleted" notice on every board load, before the
  // catalog request resolves, for views whose labels are perfectly fine.
  if (!catalog) return [];
  const live = new Set(catalog.map((l) => l.id));
  return (config?.filters?.labels ?? []).filter((id) => !live.has(id));
}

/**
 * The row's accessible name: the view name plus its filters, spoken once.
 *
 * The visible meta line is `aria-hidden`, so this is where a screen-reader user
 * gets the same content. A missing label is announced as "1 deleted label"
 * rather than silently dropped — the whole point of the tombstone is that a
 * filter which is not being applied must not look like one that is.
 */
export function savedViewAriaLabel(name: string, summary: SavedViewSummary): string {
  if (summary.isEmpty) return name;
  const parts = [...summary.segments];
  const live = summary.labels.filter((l) => l.name !== null);
  if (live.length > 0) parts.push(`Labels: ${live.map((l) => l.name).join(', ')}`);
  const missing = summary.labels.length - live.length;
  if (missing > 0) {
    parts.push(`${missing} deleted label${missing === 1 ? '' : 's'}, not applied`);
  }
  return `${name}. ${parts.join('. ')}`;
}
