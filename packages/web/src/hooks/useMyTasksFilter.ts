import { useCallback, useEffect, useState } from 'react';
import { ROLE_MEMBER } from '@/lib/roles';
import { useCurrentUser } from './useCurrentUser';
import { useCurrentUserRole } from './useCurrentUserRole';
import { useDemoMode } from './useDemoMode';

export interface UseMyTasksFilterResult {
  /** True when the filter is active. */
  enabled: boolean;
  /**
   * True until role, user, and demo mode have resolved; callers should not
   * filter yet.
   */
  isLoading: boolean;
  setEnabled: (next: boolean) => void;
}

function storageKey(userId: string, projectId: string): string {
  return `trueppm.boardFilter.mine.${userId}.${projectId}`;
}

function readStored(userId: string, projectId: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, projectId));
    if (raw === null) return null;
    return raw === '1';
  } catch {
    return null;
  }
}

function writeStored(userId: string, projectId: string, value: boolean): void {
  try {
    window.localStorage.setItem(storageKey(userId, projectId), value ? '1' : '0');
  } catch {
    // Quota or disabled storage — silently ignore; in-memory state still wins.
  }
}

/**
 * Tracks the "My tasks" Board filter (issue #198).
 *
 * Default: on for `MEMBER` role (contributors), off for SCHEDULER+. The user
 * may toggle and the choice persists per-user-per-project in localStorage.
 * Until role and user have resolved, returns `enabled=false, isLoading=true`
 * so callers can render the unfiltered view pessimistically without a
 * flash-of-empty-board.
 *
 * Read-only demo carve-out (issue #4052, decision 2026-09-24): the role-based
 * default is suppressed whenever `useDemoMode().isDemoReadOnly` is true. The
 * demo account is shared by every visitor, so "mine" has no meaning — a fresh
 * visitor otherwise lands on an empty board reading "No tasks assigned to you
 * in this project yet." An explicit stored preference (a visitor who opted in
 * themselves) still wins over this, same as it wins over the role default.
 */
export function useMyTasksFilter(
  projectId: string | undefined,
): UseMyTasksFilterResult {
  const { user, isLoading: userLoading } = useCurrentUser();
  const { role, isLoading: roleLoading } = useCurrentUserRole(projectId);
  const { isDemoReadOnly, isLoading: demoModeLoading } = useDemoMode();
  const [enabled, setEnabledState] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Wait for explicit loading flags to clear; `role` may resolve to null
    // (legitimately — e.g. the user has no membership row yet on a freshly
    // shared project). `demoModeLoading` is included so a not-yet-resolved
    // `/edition/` read can't lock in the role-based default before the demo
    // carve-out below has a chance to apply — hydration only runs once, so a
    // stale `isDemoReadOnly=false` read here would stick for the session.
    // Once all three are settled, hydrate against the stored preference,
    // falling back to the role-based default. A null role is treated as "off
    // by default" — non-members would not see assigned tasks anyway.
    if (!user || !projectId) return;
    if (userLoading || roleLoading || demoModeLoading) return;
    if (hydrated) return;
    const stored = readStored(user.id, projectId);
    if (stored !== null) {
      setEnabledState(stored);
    } else if (isDemoReadOnly) {
      setEnabledState(false);
    } else {
      setEnabledState(role === ROLE_MEMBER);
    }
    setHydrated(true);
  }, [
    user,
    projectId,
    role,
    userLoading,
    roleLoading,
    demoModeLoading,
    hydrated,
    isDemoReadOnly,
  ]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      if (user && projectId) {
        writeStored(user.id, projectId, next);
      }
    },
    [user, projectId],
  );

  return {
    enabled,
    isLoading: userLoading || roleLoading || demoModeLoading || !hydrated,
    setEnabled,
  };
}
