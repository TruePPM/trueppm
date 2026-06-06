/**
 * The single source of truth for a program-backlog session — shared verbatim
 * by the desktop two-pane layout and the distinct mobile shell so the two can
 * never drift. Owns URL state, the fixture queries, derived/filtered lists,
 * RBAC flags, every mutation handler, and the optimistic-pull → toast → undo
 * choreography (decision D6) plus the aria-live announcements that accompany it.
 *
 * Components are presentational: they read fields off this controller and call
 * its handlers. Nothing else in the feature talks to the hooks directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Program } from '@/api/types';
import { useProgram } from '@/hooks/useProgram';
import { ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';
import {
  countByStatus,
  distinctTags,
  filterItems,
  matchesSearch,
  sortItems,
  splitPulled,
  type StatusCounts,
} from '../filter';
import type { BacklogItem, MemberProject } from '../types';
import { useBacklogItem, useBacklogItems, useMemberProjects } from './useBacklogItems';
import { useBacklogMutations, type CreateBacklogItemInput } from './useBacklogMutations';
import { usePullItem, type UsePullItemOptions } from './usePullItem';
import { useBacklogUrlState, type BacklogUrlState } from './useBacklogUrlState';

/** Program-role gate on the ADR-0072 ordinal scale (the API annotates `my_role`
 *  with ROLE_* ordinals — e.g. 400 for Owner). Create / edit / pull / archive
 *  require Admin (the "full edit" tier, the PM/PO mapping of #737's "editor+");
 *  hard delete requires Owner. UI affordances only — server enforcement lands
 *  with #737. */
const SUCCESS_TOAST_MS = 4000;

export type BacklogToast =
  | { kind: 'error'; item: BacklogItem; project: MemberProject; message: string; offline: boolean }
  | { kind: 'success'; message: string }
  | null;

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { message?: string; detail?: string } } })
      .response;
    const message = response?.data?.message ?? response?.data?.detail;
    if (typeof message === 'string' && message) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'The project backlog rejected the task (validation).';
}

export interface BacklogController {
  programId: string | undefined;
  programName: string | undefined;
  /** Program identity fields for the backlog header marker (#963). */
  program: Pick<Program, 'color' | 'code' | 'name'> | undefined;
  isLoading: boolean;
  /** Page-level error class, derived from the query error status. */
  errorKind: 'forbidden' | 'not-found' | 'generic' | null;

  url: BacklogUrlState;
  allItems: BacklogItem[];
  /** Facet-filtered + sorted (search does NOT remove rows), minus the Pulled split. */
  mainItems: BacklogItem[];
  pulledItems: BacklogItem[];
  /** Count of rows matching the active search query (the "n of N" numerator). */
  matchCount: number;
  /** True while a non-empty search query is active. */
  searchActive: boolean;
  counts: StatusCounts;
  tagUniverse: string[];
  selectedItem: BacklogItem | undefined;
  memberProjects: MemberProject[];

  canEdit: boolean;
  canDelete: boolean;

  /** True for the duration of the in-flight pull (row pulse). */
  pendingPullItemId: string | null;
  toast: BacklogToast;
  liveMessage: string;
  alertMessage: string;

  pullItem: (item: BacklogItem, project: MemberProject) => void;
  retryPull: () => void;
  dismissToast: () => void;
  /** Transient status toast for not-yet-wired affordances (e.g. Import CSV). */
  notify: (message: string) => void;

  createItem: (input: CreateBacklogItemInput) => Promise<BacklogItem>;
  updateItem: (id: string, patch: Partial<BacklogItem>) => Promise<void>;
  archiveItem: (id: string) => Promise<void>;
  restoreItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  reorderItem: (id: string, newRank: number) => Promise<void>;
}

/** `pullOptions` is injectable so tests can force the pull to fail. */
export function useBacklogController(
  programId: string | undefined,
  pullOptions?: UsePullItemOptions,
): BacklogController {
  const url = useBacklogUrlState();
  const { data: program } = useProgram(programId);
  const itemsQuery = useBacklogItems(programId);
  const projectsQuery = useMemberProjects(programId);
  const mutations = useBacklogMutations(programId);
  const pull = usePullItem(programId, pullOptions);
  const selectedItem = useBacklogItem(programId, url.selectedItemId);

  const [toast, setToast] = useState<BacklogToast>(null);
  const [pendingPullItemId, setPendingPullItemId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimers = useCallback(() => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const allItems = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const counts = useMemo(() => countByStatus(allItems), [allItems]);
  const tagUniverse = useMemo(() => distinctTags(allItems), [allItems]);

  const searchActive = url.query.trim().length > 0;

  const { mainItems, pulledItems, matchCount } = useMemo(() => {
    // Facets (status/type/tags) remove rows; search only dims/highlights, so
    // the list is facet-filtered and the search query is applied separately as
    // a match count (drives the "n of N" counter and the no-results case).
    const facetFiltered = sortItems(
      filterItems(allItems, { query: '', status: url.status, types: url.types, tags: url.tags }),
    );
    const matches = searchActive
      ? facetFiltered.filter((item) => matchesSearch(item, url.query)).length
      : facetFiltered.length;
    const { main, pulled } = splitPulled(facetFiltered, url.status);
    return { mainItems: main, pulledItems: pulled, matchCount: matches };
  }, [allItems, url.query, url.status, url.types, url.tags, searchActive]);

  const myRole = program?.my_role ?? -1;
  const canEdit = myRole >= ROLE_ADMIN;
  const canDelete = myRole >= ROLE_OWNER;

  const pullItem = useCallback(
    (item: BacklogItem, project: MemberProject) => {
      clearTimers();
      // The pull commits immediately and there is no un-pull endpoint, so this
      // is a confirmation (auto-dismiss), not an undo.
      setToast({ kind: 'success', message: `Pulled to ${project.name}.` });
      setPendingPullItemId(item.id);
      setLiveMessage(`Pulled ${item.title} to ${project.name}.`);
      // Leaving pull mode in the URL returns the right pane to the item view.
      if (url.isPull) url.closePull();

      successTimer.current = setTimeout(
        () => setToast((prev) => (prev?.kind === 'success' ? null : prev)),
        SUCCESS_TOAST_MS,
      );

      pull.pull(
        { item, project },
        {
          onSuccess: () => setPendingPullItemId(null),
          onError: (error) => {
            clearTimers();
            setPendingPullItemId(null);
            setToast({
              kind: 'error',
              item,
              project,
              message: errorMessage(error),
              offline: typeof navigator !== 'undefined' && navigator.onLine === false,
            });
            setAlertMessage(`Couldn't pull to ${project.name}. Item is back in proposed.`);
          },
        },
      );
    },
    [clearTimers, pull, url],
  );

  const retryPull = useCallback(() => {
    setToast((prev) => {
      if (prev?.kind !== 'error') return prev;
      setLiveMessage('Retrying…');
      // Defer to the next tick so the toast state settles before re-pulling.
      queueMicrotask(() => pullItem(prev.item, prev.project));
      return null;
    });
  }, [pullItem]);

  const dismissToast = useCallback(() => {
    clearTimers();
    setToast(null);
  }, [clearTimers]);

  const notify = useCallback(
    (message: string) => {
      clearTimers();
      setLiveMessage(message);
      setToast({ kind: 'success', message });
      successTimer.current = setTimeout(
        () => setToast((t) => (t?.kind === 'success' ? null : t)),
        SUCCESS_TOAST_MS,
      );
    },
    [clearTimers],
  );

  const errorKind: BacklogController['errorKind'] = useMemo(() => {
    const error = itemsQuery.error as { response?: { status?: number } } | null;
    if (!error) return null;
    const status = error.response?.status;
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not-found';
    return 'generic';
  }, [itemsQuery.error]);

  return {
    programId,
    programName: program?.name,
    // Identity fields for the backlog header marker (#963). A single-program
    // board marks the program once in the header — never per row.
    program: program ? { color: program.color, code: program.code, name: program.name } : undefined,
    isLoading: itemsQuery.isLoading,
    errorKind: itemsQuery.isError ? errorKind : null,

    url,
    allItems,
    mainItems,
    pulledItems,
    matchCount,
    searchActive,
    counts,
    tagUniverse,
    selectedItem,
    memberProjects: projectsQuery.data,

    canEdit,
    canDelete,

    pendingPullItemId,
    toast,
    liveMessage,
    alertMessage,

    pullItem,
    retryPull,
    dismissToast,
    notify,

    createItem: mutations.createItem,
    updateItem: mutations.updateItem,
    archiveItem: mutations.archiveItem,
    restoreItem: mutations.restoreItem,
    deleteItem: mutations.deleteItem,
    reorderItem: mutations.reorderItem,
  };
}
