/**
 * The Grid's filter vocabulary and its URL round-trip (#2046).
 *
 * The URL is the source of truth for the working set: search, owner, status, label,
 * and the `?due=overdue` drill-down all round-trip through the query string so a
 * filtered grid survives a reload and can be shared as a link — matching the Board's
 * URL-authoritative pattern.
 *
 * Extracted from `GridView` so the component holds a view, not a filter engine: the
 * seeding, the mirror effect, the debounce, and the "clear all" reset are one unit
 * with one contract, and each can be reasoned about without the 1100-line component
 * around it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useSearchParams } from 'react-router';
import type { TaskStatus } from '@/types';
import { setSearchParam } from '@/hooks/useUrlSelectedId';
import { LABEL_PARAM, parseLabelIds, serializeLabelIds } from '@/components/filters/labelFilter';
import {
  OWNER_PARAM,
  STATUS_PARAM,
  parseIdList,
  serializeIdList,
} from '@/components/filters/facetParams';
import { parseStatuses } from '@/components/filters/statusFilter';

/** How long typing settles before the search term is applied (and mirrored to the URL). */
const SEARCH_DEBOUNCE_MS = 250;

/** Which facet panel is open. One at a time — opening Status closes Owner. */
export type GridFacetKey = 'owner' | 'status' | 'label';

export interface GridUrlFilters {
  /** Applied search term — the authoritative one, mirrored to `?q=`. */
  search: string;
  /** In-flight input value; settles into `search` after the debounce. */
  searchDraft: string;
  ownerIds: string[];
  statuses: TaskStatus[];
  labelIds: string[];
  overdue: boolean;

  /** Full Dispatch types — the chip strip removes one id at a time via the updater form. */
  setOwnerIds: Dispatch<SetStateAction<string[]>>;
  setStatuses: Dispatch<SetStateAction<TaskStatus[]>>;
  setLabelIds: Dispatch<SetStateAction<string[]>>;
  setOverdue: (next: boolean) => void;
  onSearchChange: (value: string) => void;
  /** Clearing the search chip resets both the applied term and the input together. */
  clearSearch: () => void;
  /** "Clear all" — every facet, labels included, so the chip strip unmounts entirely. */
  clearAll: () => void;

  /**
   * Which facet panel is open. Held here rather than in each facet because only a
   * shared parent can know that a sibling opened.
   */
  openFacet: GridFacetKey | null;
  setOpenFacet: (next: GridFacetKey | null) => void;
  ownerTriggerRef: RefObject<HTMLButtonElement | null>;
  statusTriggerRef: RefObject<HTMLButtonElement | null>;
  labelTriggerRef: RefObject<HTMLButtonElement | null>;
}

export function useGridUrlFilters(): GridUrlFilters {
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [searchDraft, setSearchDraft] = useState(() => searchParams.get('q') ?? '');
  // Owner and Status are multi-select as of #2387 (ADR-0624). A pre-existing
  // single-value link is a one-item list, so `?owner=Alice&status=IN_PROGRESS`
  // parses and resolves exactly as it did before.
  const [ownerIds, setOwnerIds] = useState(() => parseIdList(searchParams.get(OWNER_PARAM)));
  const [statuses, setStatuses] = useState<TaskStatus[]>(() =>
    parseStatuses(parseIdList(searchParams.get(STATUS_PARAM))),
  );
  // Label facet (`?fl=`, ADR-0620). The param name is the Board's, adopted verbatim
  // so one bookmark format works on every view — and this is purely additive: an
  // existing `?owner=…&status=…` link with no `fl` is untouched.
  const [labelIds, setLabelIds] = useState(() => parseLabelIds(searchParams.get(LABEL_PARAM)));

  const [openFacet, setOpenFacet] = useState<GridFacetKey | null>(null);
  const ownerTriggerRef = useRef<HTMLButtonElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror the applied filters into the URL. Empty values drop their key so a clean
  // grid has a clean URL. `search` (not the debounced `searchDraft`) is the
  // authoritative value, so the link reflects what the grid is actually showing.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        setOrDrop(next, 'q', search);
        setOrDrop(next, OWNER_PARAM, serializeIdList(ownerIds));
        setOrDrop(next, STATUS_PARAM, serializeIdList(statuses));
        setOrDrop(next, LABEL_PARAM, serializeLabelIds(labelIds));
        return next;
      },
      { replace: true },
    );
  }, [search, ownerIds, statuses, labelIds, setSearchParams]);

  // Drop the pending debounce on unmount so a settled search can't fire into an
  // unmounted component after a fast navigate-away.
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  // `?due=overdue` deep-link — the Overview "Tasks late" card drills in here so the
  // count it shows and the rows the grid shows use the same late definition
  // (filters.ts `isTaskOverdue` mirrors the server's `tasks_late_count`). The URL
  // param is the source of truth so the filter is shareable and survives reload.
  const overdue = searchParams.get('due') === 'overdue';
  const setOverdue = useCallback(
    (next: boolean) => {
      setSearchParam(setSearchParams, 'due', next ? 'overdue' : null);
    },
    [setSearchParams],
  );

  const onSearchChange = useCallback((value: string) => {
    setSearchDraft(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value), SEARCH_DEBOUNCE_MS);
  }, []);

  const clearSearch = useCallback(() => {
    setSearch('');
    setSearchDraft('');
  }, []);

  const clearAll = useCallback(() => {
    setSearch('');
    setSearchDraft('');
    setOwnerIds([]);
    setStatuses([]);
    setOverdue(false);
    setLabelIds([]);
  }, [setOverdue]);

  return {
    search,
    searchDraft,
    ownerIds,
    statuses,
    labelIds,
    overdue,
    setOwnerIds,
    setStatuses,
    setLabelIds,
    setOverdue,
    onSearchChange,
    clearSearch,
    clearAll,
    openFacet,
    setOpenFacet,
    ownerTriggerRef,
    statusTriggerRef,
    labelTriggerRef,
  };
}

/** Set `key` to `value`, or drop the key entirely when the value is empty. */
function setOrDrop(params: URLSearchParams, key: string, value: string): void {
  if (value) params.set(key, value);
  else params.delete(key);
}
