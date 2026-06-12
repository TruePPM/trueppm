import { useCallback } from 'react';
import { useCurrentUser } from './useCurrentUser';
import type { ApiSprint } from '@/types';

/**
 * Smart default board-sprint selection (#1141, ADR-0123).
 *
 * Resolves which sprint (if any) the board should pre-select when the URL
 * carries no explicit `?sprint=` param. Precedence:
 *   1. A stored last-explicit selection (per-user-per-project, localStorage) —
 *      but only if that sprint still exists and isn't CANCELLED.
 *   2. The project's single ACTIVE sprint, when there is exactly one.
 *   3. Project view (null).
 *
 * The `?sprint=` URL param ALWAYS wins when present (shareable links) — that
 * branch lives in BoardView and never calls `resolveDefault`. Persistence
 * mirrors `useMyTasksFilter`'s key shape
 * (`trueppm.boardSprint.{userId}.{projectId}`).
 *
 * This hook owns no state: BoardView seeds the URL once from `resolveDefault`,
 * and writes the user's explicit choices through `persist`.
 */
export interface UseDefaultBoardSprintResult {
  /** True until the current user has resolved; callers should not seed yet. */
  isLoading: boolean;
  /**
   * Compute the default sprint id (or null) given the project's sprints. Pure
   * w.r.t. its argument; reads the stored preference for the current user.
   */
  resolveDefault: (sprints: ApiSprint[]) => string | null;
  /** Persist (or clear, with `null`) the user's explicit board-scope choice. */
  persist: (projectId: string, sprintId: string | null) => void;
}

function storageKey(userId: string, projectId: string): string {
  return `trueppm.boardSprint.${userId}.${projectId}`;
}

function readStored(userId: string, projectId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(userId, projectId));
  } catch {
    return null;
  }
}

function writeStored(userId: string, projectId: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(storageKey(userId, projectId));
    else window.localStorage.setItem(storageKey(userId, projectId), value);
  } catch {
    // Quota or disabled storage — silently ignore; in-memory URL state wins.
  }
}

/**
 * Pure resolver — exported for unit testing without a React render. `storedId`
 * is the persisted choice (or null when none / storage unavailable).
 */
export function resolveDefaultSprintId(
  sprints: ApiSprint[],
  storedId: string | null,
): string | null {
  // A stored choice wins, but only if it still maps to a live, non-cancelled
  // sprint — a stale id (deleted/cancelled sprint) falls through to the auto
  // rule rather than seeding the board to an empty view.
  if (storedId) {
    const stored = sprints.find((s) => s.id === storedId);
    if (stored && stored.state !== 'CANCELLED') return storedId;
  }
  const active = sprints.filter((s) => s.state === 'ACTIVE');
  if (active.length === 1) return active[0].id;
  return null;
}

export function useDefaultBoardSprint(projectId: string | undefined): UseDefaultBoardSprintResult {
  const { user, isLoading } = useCurrentUser();

  const resolveDefault = useCallback(
    (sprints: ApiSprint[]): string | null => {
      const stored = user && projectId ? readStored(user.id, projectId) : null;
      return resolveDefaultSprintId(sprints, stored);
    },
    [user, projectId],
  );

  const persist = useCallback(
    (pid: string, sprintId: string | null) => {
      if (user) writeStored(user.id, pid, sprintId);
    },
    [user],
  );

  return { isLoading, resolveDefault, persist };
}
