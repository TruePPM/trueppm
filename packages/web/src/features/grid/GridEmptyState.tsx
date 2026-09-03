import { EmptyState } from '@/components/EmptyState';
import { useEmptyStateAnnouncement } from '@/components/emptyStateAnnouncements';
import { Button } from '@/components/Button';
import { ListIcon } from '@/components/Icons';

interface GridEmptyStateProps {
  /** Optional CTA — typically opens the unified TaskFormModal in create mode. */
  onAddTask?: () => void;
}

/** Shared empty state for all three Grid modes when the project has zero tasks. */
export function GridEmptyState({ onAddTask }: GridEmptyStateProps) {
  return (
    <EmptyState
      className="h-full bg-neutral-surface"
      icon={ListIcon}
      title="No tasks yet"
      description="Add your first task to get started — it will appear here and across every view."
      action={onAddTask ? <Button onClick={onAddTask}>+ Add task</Button> : undefined}
    />
  );
}

/**
 * One active facet's contribution to an empty result, for the multi-facet
 * diagnosis below. `standaloneCount` is how many rows this facet keeps *on its
 * own*; `recoveredCount` is how many would come back if this facet alone were
 * dropped.
 */
export interface EmptyStateFacet {
  key: string;
  /** Chip-style label, e.g. `Owner: J. Park`. */
  label: string;
  standaloneCount: number;
  recoveredCount: number;
  onDrop: () => void;
}

const COUNT_WORD: Record<number, string> = { 2: 'both', 3: 'all three', 4: 'all four' };

/**
 * Filtered-empty state for Flat / Grouped / Outline when filters yield zero rows.
 *
 * With two or more facets active this is where the AND-across/OR-within model
 * is most likely to surprise: each facet has rows on its own, so "no results"
 * reads as a bug rather than as an intersection that happens to be empty. The
 * diagnosis names each facet's standalone count and offers to drop the one
 * whose removal brings back the most rows — the single click most likely to be
 * what the user wanted.
 */
export function GridFilteredEmptyState({
  onClear,
  facets = [],
}: {
  onClear: () => void;
  facets?: EmptyStateFacet[];
}) {
  // Only worth diagnosing when the intersection is the culprit. One facet with
  // zero rows is self-explanatory.
  const diagnose = facets.length >= 2;
  // Seeded with the first facet (guaranteed present by `diagnose`) so the
  // best-recovery fold can never run against an empty array — the guard and the
  // fold are separate statements, and an unseeded reduce would turn any future
  // loosening of `diagnose` into a render throw inside the Grid.
  const best = diagnose
    ? facets.reduce((a, b) => (b.recoveredCount > a.recoveredCount ? b : a), facets[0])
    : undefined;
  const countWord = COUNT_WORD[facets.length] ?? `all ${facets.length}`;
  const headline = diagnose
    ? `No tasks match ${countWord} filters`
    : 'No tasks match these filters';

  // Announced through the shell's persistent region on the transition into
  // empty (ADR-0989), not by a `role="status"` mounted with its own text.
  // `populated → filtered-empty` is the arm that must keep announcing, and it
  // does: the headline is absent from the previous settle. Re-editing a filter
  // that leaves the surface empty at the same facet count is silent, which is
  // the defect #3198 was filed for; a facet count change rewrites the headline
  // and therefore does announce, because that is genuinely new information.
  useEmptyStateAnnouncement(headline);

  return (
    <div
      data-testid="grid-filtered-empty"
      className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface px-6
        text-center"
    >
      <p className="text-sm text-neutral-text-primary font-medium">{headline}</p>
      {diagnose && (
        <p className="max-w-md text-xs text-neutral-text-secondary">
          Each filter has rows on its own —{' '}
          {facets.map((f, i) => (
            <span key={f.key}>
              {i > 0 && ' · '}
              <span className="text-neutral-text-primary">{f.label}</span>{' '}
              <span className="tppm-mono tabular-nums">{f.standaloneCount}</span>
            </span>
          ))}{' '}
          — but nothing carries {countWord}. Filters combine with AND across facets.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {/* Standalone buttons: focus: (not focus-visible:) so the ring shows on
            pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7). */}
        {best && best.recoveredCount > 0 && (
          <button
            type="button"
            onClick={best.onDrop}
            className="
              rounded-control border border-neutral-border px-3 h-8 text-xs font-medium
              text-neutral-text-primary hover:bg-neutral-surface-raised
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            "
          >
            Drop {best.label}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="
            text-xs text-brand-primary underline
            focus:outline-none focus:ring-2 focus:ring-brand-primary
            focus:ring-offset-1
          "
        >
          {diagnose ? 'Clear all filters' : 'Clear filters'}
        </button>
      </div>
    </div>
  );
}
