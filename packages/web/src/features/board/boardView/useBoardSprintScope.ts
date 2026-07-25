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
   */
  sprintClosed: boolean;
}

export function useBoardSprintScope(
  projectId: string,
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
): BoardSprintScope {
  const projectIdOrNull = projectId || null;
  const projectIdOrUndefined = projectId || undefined;

  const { sprints } = useSprints(projectIdOrNull);
  const selectedSprintId = searchParams.get('sprint');
  const selectedSprint = useMemo(
    () => sprints.find((s) => s.id === selectedSprintId) ?? null,
    [sprints, selectedSprintId],
  );

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
  };
}
