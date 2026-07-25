/**
 * Grooming filter state (issue 1044) — the search query, DoR-state facet, and
 * "unestimated only" toggle shared by the desktop bar and the mobile toolbar.
 *
 * Local component state, not URL/localStorage: unlike the board facet bar
 * (ADR-0199, shareable links), the grooming filter is a transient find-aid the
 * PO clears as they groom, and the existing grooming view carries no URL state.
 * Keeping it local avoids widening the surface for no user-visible gain.
 *
 * The label facet (#2383, ADR-0620) follows that existing decision rather than
 * the `?fl=` convention its sibling views use: this view has *no* URL state at
 * all, so making labels alone shareable would leave a link that restores one
 * facet and silently drops readiness, search, and the unestimated toggle — worse
 * than not being shareable. Giving the whole grooming filter a URL is a separate,
 * deliberate change, not a side effect of adding one facet.
 */

import { useCallback, useMemo, useState } from 'react';
import type { DorState } from '@/types';
import { EMPTY_GROOMING_FILTERS, isFilterActive, type GroomingFilters } from '../filter';

export interface GroomingFilterControls {
  filters: GroomingFilters;
  active: boolean;
  setQuery: (query: string) => void;
  toggleDor: (state: DorState) => void;
  setUnestimatedOnly: (on: boolean) => void;
  setLabelIds: (ids: string[]) => void;
  reset: () => void;
}

export function useGroomingFilters(): GroomingFilterControls {
  const [filters, setFilters] = useState<GroomingFilters>(EMPTY_GROOMING_FILTERS);

  const setQuery = useCallback((query: string) => {
    setFilters((prev) => ({ ...prev, query }));
  }, []);

  const toggleDor = useCallback((state: DorState) => {
    setFilters((prev) => ({
      ...prev,
      dorStates: prev.dorStates.includes(state)
        ? prev.dorStates.filter((s) => s !== state)
        : [...prev.dorStates, state],
    }));
  }, []);

  const setUnestimatedOnly = useCallback((on: boolean) => {
    setFilters((prev) => ({ ...prev, unestimatedOnly: on }));
  }, []);

  const setLabelIds = useCallback((labelIds: string[]) => {
    setFilters((prev) => ({ ...prev, labelIds }));
  }, []);

  const reset = useCallback(() => setFilters(EMPTY_GROOMING_FILTERS), []);

  const active = useMemo(() => isFilterActive(filters), [filters]);

  return { filters, active, setQuery, toggleDor, setUnestimatedOnly, setLabelIds, reset };
}
