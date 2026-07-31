import { useCallback, useState, type ReactNode } from 'react';
import type { TaskStatus } from '@/types';
import { progressCompleteAutoStatus } from '@/lib/roles';
import { ProgressAutoStatusConfirmDialog } from './ProgressAutoStatusConfirmDialog';

/**
 * Statuses the server's auto-promotion never fires from (mirrors the guard in
 * `TaskSerializer._apply_percent_complete_auto_status`): a task already past
 * sign-off (COMPLETE/REVIEW) has nothing left to promote, and a BACKLOG card
 * jumping straight to done is an edge case that requires a manual promotion.
 */
const AUTO_STATUS_EXEMPT: ReadonlySet<TaskStatus> = new Set(['COMPLETE', 'REVIEW', 'BACKLOG']);

/**
 * True iff writing `percent_complete: 100` with no explicit `status` in the
 * same PATCH would trigger the server's auto-promotion (#2639). Exported so
 * callers — and tests — can reason about the trigger condition without
 * duplicating it.
 */
export function willAutoPromoteOnComplete(status: TaskStatus, percent: number): boolean {
  return percent === 100 && !AUTO_STATUS_EXEMPT.has(status);
}

interface PendingConfirm {
  targetStatus: 'REVIEW' | 'COMPLETE';
  commit: () => void;
  onCancel?: () => void;
}

export interface ProgressAutoStatusConfirm {
  /** Render alongside the caller's other overlays; null when no confirmation is pending. */
  dialog: ReactNode;
  /**
   * Gate a percent-complete write behind a confirmation naming the target
   * status, when (and only when) the write would trigger the server's silent
   * auto-promotion. `commit` runs immediately if no confirmation is needed;
   * otherwise it runs only after the user confirms. `onCancel` — e.g. reverting
   * a locally-tracked draft value back to the last committed one — runs if the
   * user dismisses the dialog instead.
   */
  requestCommit: (
    status: TaskStatus,
    percent: number,
    commit: () => void,
    onCancel?: () => void,
  ) => void;
}

/**
 * Confirmation gate for the progress-to-100 auto-status side effect (#2639).
 *
 * The server silently promotes a task to REVIEW (contributors) or COMPLETE
 * (Admin+) when `percent_complete` is written to 100 with no explicit
 * `status` in the same payload — sound governance (Option E, #381
 * follow-up), but the defect was that it happened silently, and the same
 * gesture produced two different outcomes depending on who performed it with
 * nothing in the UI saying so. `requestCommit` intercepts every such write:
 * when it would trigger the promotion, it renders a dialog naming the
 * *actual* target status for the *acting* user's role (mirroring the
 * server's role check via `progressCompleteAutoStatus`) and only calls
 * `commit` if the user confirms. Writes that would not trigger the
 * promotion (percent < 100, or the task is already past sign-off) skip the
 * dialog and commit immediately — this is a one-time confirmation for a
 * side effect, not a tax on every progress edit.
 */
export function useProgressAutoStatusConfirm(role: number | null | undefined): ProgressAutoStatusConfirm {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const requestCommit = useCallback(
    (status: TaskStatus, percent: number, commit: () => void, onCancel?: () => void) => {
      if (!willAutoPromoteOnComplete(status, percent)) {
        commit();
        return;
      }
      setPending({ targetStatus: progressCompleteAutoStatus(role), commit, onCancel });
    },
    [role],
  );

  const dialog = pending ? (
    <ProgressAutoStatusConfirmDialog
      targetStatus={pending.targetStatus}
      onConfirm={() => {
        const { commit } = pending;
        setPending(null);
        commit();
      }}
      onCancel={() => {
        const { onCancel } = pending;
        setPending(null);
        onCancel?.();
      }}
    />
  ) : null;

  return { dialog, requestCommit };
}
