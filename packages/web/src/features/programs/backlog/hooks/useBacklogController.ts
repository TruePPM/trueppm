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
import type { EstimationScale, Program } from '@/api/types';
import type { Methodology } from '@/types';
import { useProgram } from '@/hooks/useProgram';
import { resolveMethodology } from '../methodologyVocabulary';
import { ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';
import {
  countByStatus,
  distinctTags,
  filterItems,
  matchesSearch,
  nextPriorityRank,
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
// A pull toast now offers a "Go to task" hop (#1994), so it lingers longer than a
// bare confirmation — long enough to read and click before it auto-dismisses.
const PULL_TOAST_MS = 8000;

export type BacklogToast =
  | { kind: 'error'; item: BacklogItem; project: MemberProject; message: string; offline: boolean }
  // projectId is known the instant the pull starts (the user picked it); taskId
  // is filled in on success so the toast can deep-link to the created task (#1994).
  | { kind: 'success'; message: string; projectId?: string; taskId?: string }
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
  /** Program's resolved estimation scale (ADR-0510, #2027) — drives the points
   *  picker/labels on the create + detail panes. Fibonacci until the program loads. */
  estimationScale: EstimationScale;
  /**
   * The program's resolved methodology (#3644). Governs authoring vocabulary —
   * an intake item is program-scoped and has no project until it is pulled, so
   * this is the only methodology in scope while it is being written. The *pull*
   * preview reads the target project's own value instead.
   */
  methodology: Methodology;
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
  /** Transient status toast for not-yet-wired affordances (general-purpose). */
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
  const programQuery = useProgram(programId);
  const program = programQuery.data;
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

  // Wires a rank onto every item created through the UI (#2668 — the create
  // mutation never sent priority_rank, so it stayed null forever and "Sorted
  // by priority" was vacuous on any pool created this way). Computed from the
  // live, unfiltered set so the new item always lands at the true bottom.
  const createItem = useCallback(
    (input: CreateBacklogItemInput) =>
      mutations.createItem({ ...input, priorityRank: nextPriorityRank(allItems) }),
    [mutations, allItems],
  );

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
      // is a confirmation (auto-dismiss), not an undo. projectId is set now so the
      // toast can offer wayfinding; taskId is patched in on success (#1994).
      setToast({ kind: 'success', message: `Pulled to ${project.name}.`, projectId: project.id });
      setPendingPullItemId(item.id);
      setLiveMessage(`Pulled ${item.title} to ${project.name}.`);
      // Leaving pull mode in the URL returns the right pane to the item view.
      if (url.isPull) url.closePull();

      successTimer.current = setTimeout(
        () => setToast((prev) => (prev?.kind === 'success' ? null : prev)),
        PULL_TOAST_MS,
      );

      pull.pull(
        { item, project },
        {
          onSuccess: (result) => {
            setPendingPullItemId(null);
            // Attach the created task id so "Go to task" can deep-link (#1994).
            setToast((prev) =>
              prev?.kind === 'success' ? { ...prev, taskId: result.taskId } : prev,
            );
          },
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

  // Classifies whichever of the page's two queries failed. Reading only the
  // items error would flatten a failed program read to `generic` and lose the
  // bespoke 403/404 copy the page already has — a real loss of classification,
  // reachable when the items query serves from a warm cache while access is
  // revoked underneath it (#3644, surfaced by `regression-check`).
  const errorKind: BacklogController['errorKind'] = useMemo(() => {
    const error = (itemsQuery.error ?? programQuery.error) as {
      response?: { status?: number };
    } | null;
    if (!error) return null;
    const status = error.response?.status;
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not-found';
    return 'generic';
  }, [itemsQuery.error, programQuery.error]);

  return {
    programId,
    programName: program?.name,
    // Identity fields for the backlog header marker (#963). A single-program
    // board marks the program once in the header — never per row.
    program: program ? { color: program.color, code: program.code, name: program.name } : undefined,
    // BOTH queries gate the page, not just the items one (#3644). The program
    // read supplies `methodology`, and `DetailCreate` SEEDS a `useDirtyDraft`
    // baseline from it — a baseline the hook captures once at mount and
    // deliberately never resyncs. Every other consumer of that value
    // (`pointsLabel`, `typeOptions`) recomputes on render, so a late-arriving
    // program silently desyncs the frozen one: the Type dropdown reorders to
    // lead with Task while the selected value stays `story`, and the form then
    // POSTs `item_type: 'story'` into a Waterfall program. The visible surface
    // self-corrects and the persisted value does not, which is why gating is
    // the fix rather than a re-render (web-rule 410).
    //
    // The error is folded in for the same reason in its deterministic form: a
    // failed `GET /programs/{id}/` leaves `program` undefined forever, and
    // `resolveMethodology(undefined)` then stands as HYBRID — one of the three
    // REAL answers asserted as fact on a program that may be neither. Both
    // errors go through the SAME classifier above, so a 403 on either query
    // still reads as "forbidden" rather than collapsing to the generic retry.
    isLoading: itemsQuery.isLoading || programQuery.isLoading,
    errorKind: itemsQuery.isError || programQuery.isError ? errorKind : null,

    url,
    allItems,
    mainItems,
    pulledItems,
    matchCount,
    searchActive,
    counts,
    tagUniverse,
    estimationScale: program?.effective_estimation_scale ?? 'fibonacci',
    methodology: resolveMethodology(program?.effective_methodology),
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

    createItem,
    updateItem: mutations.updateItem,
    archiveItem: mutations.archiveItem,
    restoreItem: mutations.restoreItem,
    deleteItem: mutations.deleteItem,
    reorderItem: mutations.reorderItem,
  };
}
