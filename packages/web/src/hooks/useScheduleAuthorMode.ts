import { useCallback, useEffect, useState } from 'react';
import { useCurrentUser } from './useCurrentUser';

export type ScheduleAuthorMode = 'author' | 'read';

export interface UseScheduleAuthorModeResult {
  /** 'author' (default) allows every build-mode mutation; 'read' forces readOnly. */
  mode: ScheduleAuthorMode;
  /** True until user + the stored preference have resolved. */
  isLoading: boolean;
  setMode: (next: ScheduleAuthorMode) => void;
  toggle: () => void;
}

function storageKey(userId: string, projectId: string): string {
  return `trueppm.schedule.authorMode.${userId}.${projectId}`;
}

function readStored(userId: string, projectId: string): ScheduleAuthorMode | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, projectId));
    return raw === 'read' || raw === 'author' ? raw : null;
  } catch {
    return null;
  }
}

function writeStored(userId: string, projectId: string, value: ScheduleAuthorMode): void {
  try {
    window.localStorage.setItem(storageKey(userId, projectId), value);
  } catch {
    // Quota or disabled storage — silently ignore; in-memory state still wins.
  }
}

/**
 * Alt+A Author/Read toggle (#2727, ADR-0776 §5) — a per-user-per-project
 * client-only preference, not a permission change. "Read" mode is a
 * deliberate override the user opts into for reviewing a plan without
 * risking an accidental edit; the server's RBAC is untouched, and a
 * determined user can always flip it back. Follows the same
 * localStorage-per-user-per-project convention as `useMyTasksFilter`.
 * Default is 'author' — the mode the Schedule already ships in today.
 */
export function useScheduleAuthorMode(
  projectId: string | undefined,
): UseScheduleAuthorModeResult {
  const { user, isLoading: userLoading } = useCurrentUser();
  const [mode, setModeState] = useState<ScheduleAuthorMode>('author');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!user || !projectId) return;
    if (userLoading) return;
    if (hydrated) return;
    const stored = readStored(user.id, projectId);
    if (stored) setModeState(stored);
    setHydrated(true);
  }, [user, projectId, userLoading, hydrated]);

  const setMode = useCallback(
    (next: ScheduleAuthorMode) => {
      setModeState(next);
      if (user && projectId) {
        writeStored(user.id, projectId, next);
      }
    },
    [user, projectId],
  );

  const toggle = useCallback(() => {
    setMode(mode === 'author' ? 'read' : 'author');
  }, [mode, setMode]);

  return {
    mode,
    isLoading: userLoading || !hydrated,
    setMode,
    toggle,
  };
}
