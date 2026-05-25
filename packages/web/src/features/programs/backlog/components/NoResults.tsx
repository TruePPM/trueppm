/**
 * Shown inside the list pane when the program has items but the active
 * filters/search reduce them to zero. Offers recovery paths rather than a bare
 * "0 items" — Clear search (only when a query is set) and Reset filters (only
 * when a non-status facet is active). The search term is quoted verbatim.
 */

import { BTN_SECONDARY } from './styles';

interface NoResultsProps {
  query: string;
  totalCount: number;
  hasActiveFacets: boolean;
  onClearSearch: () => void;
  onResetFilters: () => void;
}

export function NoResults({
  query,
  totalCount,
  hasActiveFacets,
  onClearSearch,
  onResetFilters,
}: NoResultsProps) {
  const trimmed = query.trim();
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <h3 className="text-sm font-semibold text-neutral-text-primary">
        {trimmed ? `Nothing matches "${trimmed}"` : 'Nothing matches these filters'}
      </h3>
      <p className="mt-2 max-w-[320px] text-xs leading-relaxed text-neutral-text-secondary">
        Try a different word, or clear the filter to see all {totalCount}{' '}
        {totalCount === 1 ? 'item' : 'items'}.
      </p>
      <div className="mt-4 flex items-center gap-2">
        {trimmed && (
          <button type="button" className={BTN_SECONDARY} onClick={onClearSearch}>
            Clear search
          </button>
        )}
        {hasActiveFacets && (
          <button type="button" className={BTN_SECONDARY} onClick={onResetFilters}>
            Reset filters
          </button>
        )}
      </div>
    </div>
  );
}
