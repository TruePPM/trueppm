/**
 * Single owner of all program-backlog toolbar + pane state, encoded in the URL
 * query string (decision D8). Keeping every piece of state URL-addressable
 * means deep-links, refresh, and the browser back button all "just work" —
 * `?item=BI-003` reopens the detail pane, `?status=PROPOSED&type=story` restores
 * the filter, `?pull=1` re-enters the pull flow.
 *
 * Components never touch `useSearchParams` directly; they go through the
 * typed getters/setters here so the param vocabulary lives in one place.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { BACKLOG_ITEM_TYPES, type BacklogItemStatus, type BacklogItemType } from '../types';

const STATUS_VALUES: BacklogItemStatus[] = ['PROPOSED', 'PULLED', 'ARCHIVED'];

function parseStatus(raw: string | null): BacklogItemStatus | null {
  return raw && (STATUS_VALUES as string[]).includes(raw) ? (raw as BacklogItemStatus) : null;
}

function parseList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const set = new Set(allowed as readonly string[]);
  return raw.split(',').filter((v) => set.has(v)) as T[];
}

export interface BacklogUrlState {
  query: string;
  status: BacklogItemStatus | null;
  types: BacklogItemType[];
  tags: string[];
  selectedItemId: string | null;
  isNew: boolean;
  isPull: boolean;
  pulledOpen: boolean;

  setQuery: (q: string) => void;
  clearSearch: () => void;
  setStatus: (s: BacklogItemStatus | null) => void;
  setTypes: (t: BacklogItemType[]) => void;
  setTags: (t: string[]) => void;
  resetFilters: () => void;

  /** Open the detail view for an item (clears create/pull modes). */
  selectItem: (id: string | null) => void;
  /** Swap the right pane to the create form. */
  openCreate: () => void;
  /** Enter the pull-confirm flow for an item. */
  openPull: (id: string) => void;
  /** Leave pull mode, keeping the item selected. */
  closePull: () => void;
  /** Clear the right pane back to empty. */
  closeDetail: () => void;
  setPulledOpen: (open: boolean) => void;
}

export function useBacklogUrlState(): BacklogUrlState {
  const [params, setParams] = useSearchParams();

  const update = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutate(next);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      update((next) => {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      });
    },
    [update],
  );

  const query = params.get('q') ?? '';
  const status = parseStatus(params.get('status'));
  const types = useMemo(() => parseList(params.get('type'), BACKLOG_ITEM_TYPES), [params]);
  const tags = useMemo(() => (params.get('tags') ? params.get('tags')!.split(',') : []), [params]);
  const selectedItemId = params.get('item');
  const isNew = params.get('new') === '1';
  const isPull = params.get('pull') === '1';
  const pulledOpen = params.get('pulled') === '1';

  return {
    query,
    status,
    types,
    tags,
    selectedItemId,
    isNew,
    isPull,
    pulledOpen,

    setQuery: (q) => setParam('q', q || null),
    clearSearch: () => setParam('q', null),
    setStatus: (s) => setParam('status', s),
    setTypes: (t) => setParam('type', t.length ? t.join(',') : null),
    setTags: (t) => setParam('tags', t.length ? t.join(',') : null),
    resetFilters: () =>
      update((next) => {
        next.delete('status');
        next.delete('type');
        next.delete('tags');
      }),

    selectItem: (id) =>
      update((next) => {
        next.delete('new');
        next.delete('pull');
        if (id) next.set('item', id);
        else next.delete('item');
      }),
    openCreate: () =>
      update((next) => {
        next.delete('item');
        next.delete('pull');
        next.set('new', '1');
      }),
    openPull: (id) =>
      update((next) => {
        next.delete('new');
        next.set('item', id);
        next.set('pull', '1');
      }),
    closePull: () => setParam('pull', null),
    closeDetail: () =>
      update((next) => {
        next.delete('item');
        next.delete('new');
        next.delete('pull');
      }),
    setPulledOpen: (open) => setParam('pulled', open ? '1' : null),
  };
}
