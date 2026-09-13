import { useCallback, useState } from 'react';
import { useBaselines } from '@/hooks/useBaselines';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { ScheduleAuthorMode } from '@/hooks/useScheduleAuthorMode';

function ackKey(userId: string, projectId: string): string {
  return `trueppm.schedule.baselineAck.${userId}.${projectId}`;
}

function readAck(userId: string, projectId: string): string | null {
  try {
    return window.localStorage.getItem(ackKey(userId, projectId));
  } catch {
    return null;
  }
}

function writeAck(userId: string, projectId: string, baselineId: string): void {
  try {
    window.localStorage.setItem(ackKey(userId, projectId), baselineId);
  } catch {
    // Storage refused — the confirm simply asks again next time.
  }
}

interface BaselinedAuthorGate {
  /**
   * Toggle Read ⇄ Author, asking first when leaving Read on a baselined plan.
   * Returns `true` when the mode changed now, `false` when a confirm opened
   * instead — so a caller that announces the change can stay silent until it
   * actually happens.
   */
  requestToggle: () => boolean;
  /** Whether the confirm is open. */
  confirmOpen: boolean;
  /** Active baseline name, or `null` while the baselines read is unsettled. */
  confirmBaselineName: string | null;
  /** Acknowledge the baseline and enter Author. */
  confirm: () => void;
  cancel: () => void;
  /** Name of the active baseline once settled; `undefined` when there is none. */
  activeBaselineName: string | undefined;
}

/**
 * The once-per-baseline confirm in front of Author mode (#3748).
 *
 * The acknowledgment is keyed by baseline **id**, not by project, so capturing
 * and activating a new baseline re-arms it — that is the moment the agreed plan
 * changed, and the only moment the warning says something new. Like the mode
 * itself (`useScheduleAuthorMode`) this is a per-user-per-project client
 * preference: it records that this person saw the sentence, and is not a
 * governance record — the server keeps every baseline regardless, and the
 * durable amend trail is #3150's.
 *
 * An unsettled or failed baselines read asks rather than passing (web rule 392).
 * A warning predicate that reads `undefined` as "no baseline" is silent in
 * exactly the case it cannot see, and there is no acknowledgment to store, so
 * that branch asks every time until the read lands.
 */
export function useBaselinedAuthorGate(
  projectId: string | undefined,
  mode: ScheduleAuthorMode,
  toggle: () => void,
): BaselinedAuthorGate {
  const { user } = useCurrentUser();
  const { data: baselines, isLoading, isError } = useBaselines(projectId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const unsettled = projectId !== undefined && (isLoading || isError || baselines === undefined);
  const active = baselines?.find((b) => b.is_active);

  const requestToggle = useCallback((): boolean => {
    if (mode === 'author' || projectId === undefined) {
      toggle();
      return true;
    }
    if (!unsettled && !active) {
      toggle();
      return true;
    }
    if (active && user && readAck(user.id, projectId) === active.id) {
      toggle();
      return true;
    }
    setConfirmOpen(true);
    return false;
  }, [mode, projectId, unsettled, active, user, toggle]);

  const confirm = useCallback(() => {
    if (active && user && projectId !== undefined) writeAck(user.id, projectId, active.id);
    setConfirmOpen(false);
    if (mode === 'read') toggle();
  }, [active, user, projectId, mode, toggle]);

  const cancel = useCallback(() => setConfirmOpen(false), []);

  return {
    requestToggle,
    confirmOpen,
    confirmBaselineName: active ? active.name : null,
    confirm,
    cancel,
    activeBaselineName: unsettled ? undefined : active?.name,
  };
}
