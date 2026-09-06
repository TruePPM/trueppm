/**
 * Board sprint scope (#429, #1141) — which sprint the phase columns are scoped
 * to, and the one-shot smart default that picks one on first load.
 *
 * Lifted out of `BoardView` for #2378. The cluster is four things that only
 * make sense together: the `?sprint=` URL param, the sprint it resolves to, the
 * seeding effect that fills it in when absent, and the closed-sprint read-only
 * flag derived from it.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SetURLSearchParams } from 'react-router';
import { useSprints } from '@/hooks/useSprints';
import { useDefaultBoardSprint } from '@/hooks/useDefaultBoardSprint';
import { setSearchParam } from '@/hooks/useUrlSelectedId';
import type { ApiSprint } from '@/types';

export interface BoardSprintScope {
  sprints: ApiSprint[];
  /** The raw `?sprint=` param — set even while `sprints` is still loading. */
  selectedSprintId: string | null;
  selectedSprint: ApiSprint | null;
  /** Display name of the scoped sprint — undefined in Project view. */
  selectedSprintName: string | undefined;
  setSelectedSprintId: (id: string | null) => void;
  /**
   * A COMPLETED sprint board is a retrospective read: drag-to-assign is disabled
   * board-wide so a card move never back-dates scope into a closed sprint.
   *
   * Positively known only — `false` while the sprint's state is still unknown
   * (see `sprintStateUnknown`). The closed-sprint banner keys off this alone,
   * because a banner is a disclosure and a disclosure defaults to silent.
   */
  sprintClosed: boolean;
  /**
   * The URL names a sprint whose state this hook cannot yet vouch for: the
   * sprints query is still loading, or it failed and never delivered the list.
   * The board's write-lock treats this exactly like `sprintClosed` — an
   * unresolved read is "unknown", not "open", and a guard that reads it as
   * open is skipped on timing alone (#3424, the #3313 class). `false` once the
   * list resolves, and always `false` in Project view (no `?sprint=`).
   */
  sprintStateUnknown: boolean;
}

export function useBoardSprintScope(
  projectId: string,
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
): BoardSprintScope {
  const projectIdOrNull = projectId || null;
  const projectIdOrUndefined = projectId || undefined;

  const { sprints, isLoading: sprintsLoading, error: sprintsError } = useSprints(projectIdOrNull);
  const selectedSprintId = searchParams.get('sprint');
  const selectedSprint = useMemo(
    () => sprints.find((s) => s.id === selectedSprintId) ?? null,
    [sprints, selectedSprintId],
  );
  // `sprints` is `[]` both while the query is in flight and after it failed, so
  // a scoped board on a cold mount resolves `selectedSprint` to null and would
  // read as an open, editable sprint until the list lands — BoardView never
  // calls `useSprints` itself, so this is a cold query on every mount. Only a
  // list that resolved and still lacks the id counts as "not closed"; a stale
  // list kept through a refetch error still answers, so it is not unknown.
  const sprintStateUnknown =
    selectedSprintId !== null &&
    selectedSprint === null &&
    (sprintsLoading || sprintsError != null);

  // Smart default board scope (#1141): the user's last explicit choice
  // (per-user-per-project, localStorage) or the single ACTIVE sprint. The URL
  // param always wins — `setSelectedSprintId` writes it and also persists the
  // choice so the next visit (without a shared link) restores it.
  const defaultSprint = useDefaultBoardSprint(projectIdOrUndefined);
  const setSelectedSprintId = useCallback(
    (id: string | null) => {
      if (projectId) defaultSprint.persist(projectId, id);
      setSearchParam(setSearchParams, 'sprint', id);
    },
    [setSearchParams, defaultSprint, projectId],
  );

  // Seed the board scope once on first load when the URL carries no explicit
  // `?sprint=` (a shared link is authoritative and skips this entirely). Runs
  // after sprints + current user resolve; the ref guard keeps it one-shot so a
  // user who deliberately switches back to Project view isn't re-defaulted.
  const seededDefaultRef = useRef(false);
  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (!projectId || defaultSprint.isLoading) return;
    if (searchParams.has('sprint')) {
      seededDefaultRef.current = true;
      return;
    }
    if (sprints.length === 0) return; // wait for sprints to load before deciding
    seededDefaultRef.current = true;
    const def = defaultSprint.resolveDefault(sprints);
    if (def) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('sprint', def);
          return next;
        },
        { replace: true },
      );
    }
  }, [projectId, defaultSprint, sprints, searchParams, setSearchParams]);

  return {
    sprints,
    selectedSprintId,
    selectedSprint,
    selectedSprintName: selectedSprint?.name,
    setSelectedSprintId,
    sprintClosed: selectedSprint?.state === 'COMPLETED',
    sprintStateUnknown,
  };
}
