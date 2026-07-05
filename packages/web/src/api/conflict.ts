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
