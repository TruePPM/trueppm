import { useCallback, useEffect, useState } from 'react';
import { useCurrentUser } from './useCurrentUser';
import { useDemoMode } from './useDemoMode';

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
 *
 * **The read-only demo is the one deployment where that default is wrong
 * (#4050 A6).** `atlas-visitor` genuinely holds edit rights, so `readOnly`
 * resolves false and a first-time evaluator lands in Author: drag handles,
 * link dots, an insert cursor, and a plan that refuses every write they try.
 * Under `isDemoReadOnly` the mode therefore **initializes to `'read'`** and the
 * stored preference is neither read nor written — the demo login is *shared*,
 * so a stored `author` is not this visitor's choice at all but the last
 * visitor's, in a browser profile that may have been used by someone else
 * entirely. An Author choice made during a visit lasts for the page session and
 * dies with it, which is also what the design's spec table asks for (session-only
 * mode). Normal installs are untouched: the demo is a property of the deployment
 * (`GET /api/v1/edition/`), not of the user or the project.
 */
export function useScheduleAuthorMode(
  projectId: string | undefined,
): UseScheduleAuthorModeResult {
  const { user, isLoading: userLoading } = useCurrentUser();
  const { isDemoReadOnly } = useDemoMode();
  const [mode, setModeState] = useState<ScheduleAuthorMode>('author');
  const [hydrated, setHydrated] = useState(false);

  // Every page load and every project switch starts the demo in Read. The reset
  // is keyed on `projectId` rather than done once at mount because the demo's
  // sample-project switcher navigates between projects inside one page session,
  // and a visitor who entered Author on Migration Tooling has not asked to
  // author Platform Core.
  useEffect(() => {
    if (!isDemoReadOnly) return;
    setModeState('read');
    setHydrated(true);
  }, [isDemoReadOnly, projectId]);

  // Deliberately NOT gated on the edition read being settled. `/edition/` is
  // fetched once at shell boot with `staleTime: Infinity`, but making the stored
  // preference wait on it would hold every normal install's Read hydration
  // behind a request that has nothing to do with it — and the demo does not need
  // the wait, because the effect above re-asserts Read the moment the answer
  // arrives.
  useEffect(() => {
    if (isDemoReadOnly) return;
    if (!user || !projectId) return;
    if (userLoading) return;
    if (hydrated) return;
    const stored = readStored(user.id, projectId);
    if (stored) setModeState(stored);
    setHydrated(true);
  }, [user, projectId, userLoading, hydrated, isDemoReadOnly]);

  const setMode = useCallback(
    (next: ScheduleAuthorMode) => {
      setModeState(next);
      // Deliberately NOT persisted in the demo — see the hook docstring. The
      // in-memory state still changes, so "Try it" and ⌥A work for the session.
      if (isDemoReadOnly) return;
      if (user && projectId) {
        writeStored(user.id, projectId, next);
      }
    },
    [user, projectId, isDemoReadOnly],
  );

  const toggle = useCallback(() => {
    setMode(mode === 'author' ? 'read' : 'author');
  }, [mode, setMode]);

  return {
    mode,
    // The demo has no stored preference to hydrate, so it is settled as soon as
    // the edition answer says it is a demo — reporting "still loading" past that
    // would hold the Schedule's first paint on a read it never makes.
    isLoading: isDemoReadOnly ? false : userLoading || !hydrated,
    setMode,
    toggle,
  };
}
