import axios from 'axios';
import { toast } from '@/components/Toast';

/**
 * Sync conflict handling for stale-`server_version` writes (ADR-0217, issue 322).
 *
 * When a client PATCHes an entity it last saw at `base_version` and another
 * writer has since changed an overlapping field, the API returns `409` with a
 * structured body. This module detects that response and surfaces the
 * "Someone else changed this" toast with a **Reload** action that refetches the
 * affected query, so the loser's edit is never silently discarded.
 *
 * Disjoint edits merge server-side (200) and never reach here.
 */

/** Structured 409 body returned by the API on an overlapping concurrent edit. */
export interface SyncConflict {
  code: 'sync_conflict';
  detail: string;
  /** Fields both writers touched. */
  conflict_fields: string[];
  /** Current server values for the conflicting fields (RBAC-filtered). */
  server_value: Record<string, unknown>;
  /** The values this client tried to write. */
  client_value: Record<string, unknown>;
  /** The server's current version — the value to rebase on after reloading. */
  server_version: number;
  /** Set when the intervening history was unmergeable and the write failed closed. */
  ambiguous?: boolean;
}

/** Narrow an unknown mutation error to a structured {@link SyncConflict} 409, or null. */
export function asSyncConflict(error: unknown): SyncConflict | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data = error.response.data as Partial<SyncConflict> | undefined;
  if (data?.code === 'sync_conflict') return data as SyncConflict;
  return null;
}

/** True when the error is a sync conflict (overlapping concurrent edit). */
export function isSyncConflict(error: unknown): boolean {
  return asSyncConflict(error) !== null;
}

/**
 * Show the conflict toast with a Reload action, if `error` is a sync conflict.
 *
 * Returns `true` when the error was a conflict (and the toast was shown), so a
 * mutation's `onError` can suppress its generic error toast / rollback-only path.
 * `onReload` should invalidate the relevant query so the user sees the server's
 * current state before reapplying their edit.
 */
export function handleSyncConflict(error: unknown, onReload: () => void): boolean {
  const conflict = asSyncConflict(error);
  if (!conflict) return false;
  toast.action(
    conflict.detail,
    { label: 'Reload', onClick: onReload, ariaLabel: 'Reload to see the latest changes' },
    { variant: 'error' },
  );
  return true;
}

/**
 * Structured 409 body for a commitment slip the caller cannot apply (ADR-1485 D1).
 *
 * The date write moved committed sprint work past the end of its ACTIVE sprint.
 * The server did NOT apply it: it recorded a PENDING scope change that someone
 * who can accept scope changes (Admin+) decides. The edit is waiting, not lost.
 */
export interface CommitmentSlipConflict {
  code: 'commitment_slip_requires_acceptance';
  detail: string;
  /** The role the tree implies for the task. */
  structure_role: 'work' | 'container';
  scope_change_id: string;
  batch_id: string | null;
  sprint_id: string;
  sprint_name: string;
  proposed_start: string | null;
  proposed_finish: string | null;
  /** The end date of the sprint the move would pass. */
  sprint_finish_date?: string;
  /** The task's planned start and finish, which this request left unchanged. */
  current_start?: string | null;
  current_finish?: string | null;
}

/** Narrow an unknown mutation error to a {@link CommitmentSlipConflict} 409, or null. */
export function asCommitmentSlip(error: unknown): CommitmentSlipConflict | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data = error.response.data as Partial<CommitmentSlipConflict> | undefined;
  if (data?.code === 'commitment_slip_requires_acceptance') return data as CommitmentSlipConflict;
  return null;
}

/** The copy for a deferred slip: "Waiting for a Sprint 4 decision". */
export function commitmentSlipMessage(slip: Pick<CommitmentSlipConflict, 'sprint_name'>): string {
  return `Waiting for a ${slip.sprint_name} decision`;
}

/**
 * True when the server needs a reason for a commitment slip the caller may apply
 * (a 400 carrying a `slip_reason` field error, ADR-1485 D1).
 */
export function isSlipReasonRequired(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 400) return false;
  const data = error.response.data as { slip_reason?: unknown } | undefined;
  return Array.isArray(data?.slip_reason);
}
