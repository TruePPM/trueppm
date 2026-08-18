import { useCallback, useEffect, useState } from 'react';
import { useCurrentUser } from './useCurrentUser';

/**
 * Per-person display preferences for the schedule outline (#2959, epic #2946).
 *
 * These exist because a persona panel split on three of them and picking a
 * winner would have been wrong either way — one planner wanted the structure
 * buttons gone (`⌥⌘G` and `⇥` already make phases), a PMO wanted them kept
 * because creating a phase is their first act and shouldn't need a chord. So
 * each is a setting, and **the default takes the leaner reading**.
 *
 * Nothing here touches the plan. It is only what this person sees, which is why
 * it is a client preference rather than a project setting: two people looking at
 * the same schedule are allowed to want different chrome.
 */
export interface ScheduleDisplayOptions {
  /** Phase / Group / Ungroup in the toolbar. Default off — the keys already do it. */
  structureButtons: boolean;
  /** The three-line how-to bar above the outline. Default on, dismissible. */
  coach: boolean;
  /** 44px rows and larger controls — the same sizing coarse pointers get automatically. */
  comfortableRows: boolean;
}

export const DEFAULT_DISPLAY_OPTIONS: ScheduleDisplayOptions = {
  structureButtons: false,
  coach: true,
  comfortableRows: false,
};

export type ScheduleDisplayOptionKey = keyof ScheduleDisplayOptions;

export interface UseScheduleDisplayOptionsResult {
  options: ScheduleDisplayOptions;
  toggle: (key: ScheduleDisplayOptionKey) => void;
  set: (key: ScheduleDisplayOptionKey, value: boolean) => void;
}

function storageKey(userId: string, projectId: string): string {
  return `trueppm.schedule.displayOptions.${userId}.${projectId}`;
}

function readStored(userId: string, projectId: string): Partial<ScheduleDisplayOptions> | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, projectId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Read key by key rather than trusting the blob: a stored value from an
    // older shape (or a hand-edited one) must not put a non-boolean into state
    // and make `checked` render as undefined.
    const out: Partial<ScheduleDisplayOptions> = {};
    for (const key of Object.keys(DEFAULT_DISPLAY_OPTIONS) as ScheduleDisplayOptionKey[]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

function writeStored(userId: string, projectId: string, value: ScheduleDisplayOptions): void {
  try {
    window.localStorage.setItem(storageKey(userId, projectId), JSON.stringify(value));
  } catch {
    // Quota or disabled storage — in-memory state still wins for this session.
  }
}

export function useScheduleDisplayOptions(
  projectId: string | undefined,
): UseScheduleDisplayOptionsResult {
  const { user, isLoading: userLoading } = useCurrentUser();
  const [options, setOptions] = useState<ScheduleDisplayOptions>(DEFAULT_DISPLAY_OPTIONS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!user || !projectId || userLoading || hydrated) return;
    const stored = readStored(user.id, projectId);
    if (stored) setOptions((cur) => ({ ...cur, ...stored }));
    setHydrated(true);
  }, [user, projectId, userLoading, hydrated]);

  const set = useCallback(
    (key: ScheduleDisplayOptionKey, value: boolean) => {
      setOptions((cur) => {
        const next = { ...cur, [key]: value };
        if (user && projectId) writeStored(user.id, projectId, next);
        return next;
      });
    },
    [user, projectId],
  );

  const toggle = useCallback(
    (key: ScheduleDisplayOptionKey) => {
      setOptions((cur) => {
        const next = { ...cur, [key]: !cur[key] };
        if (user && projectId) writeStored(user.id, projectId, next);
        return next;
      });
    },
    [user, projectId],
  );

  return { options, toggle, set };
}
