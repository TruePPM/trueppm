/**
 * Pure sync-status state machine (ADR-0203).
 *
 * The SyncStatusBadge state is a projection of three client-side facts: browser
 * connectivity, the TanStack Query mutation cache (in-flight / paused / errored
 * writes), and the last successful sync time. Keeping the derivation pure and
 * framework-free makes the precedence rules unit-testable and lets a future
 * mobile/PWA surface reuse the exact same vocabulary.
 */

export type SyncStatusKind = 'synced' | 'syncing' | 'offline' | 'error';

export type SyncStatus =
  | { kind: 'synced'; lastSyncAt: number | null }
  | { kind: 'syncing'; count: number; lastSyncAt: number | null }
  | { kind: 'offline'; pending: number; lastSyncAt: number | null }
  | {
      kind: 'error';
      errorCount: number;
      lastError: string | null;
      lastSyncAt: number | null;
    };

export interface SyncInputs {
  /** `navigator.onLine` — false when the browser reports no connection. */
  online: boolean;
  /** Mutations actively hitting the server (`pending` and not paused). */
  inFlightCount: number;
  /** Mutations queued because the client is offline (`isPaused`). */
  pausedCount: number;
  /** Mutations that failed terminally and need user attention. */
  errorCount: number;
  /** Message of the most recent errored mutation, if any. */
  lastError: string | null;
  /** Epoch ms of the last successful write this session. */
  lastSyncAt: number | null;
}

/**
 * Map raw sync facts to a single badge state.
 *
 * Precedence (first match wins) — chosen so the badge stays calm, not alarming:
 * 1. `offline` — when the browser is offline, paused writes *are* the story and
 *    the user can't act on an error anyway, so this dominates (calm orange).
 * 2. `error` — only once online does a failed write escalate to red/retry.
 * 3. `syncing` — writes draining to the server (least urgent).
 * 4. `synced` — silent; everything is saved.
 */
export function deriveSyncStatus(i: SyncInputs): SyncStatus {
  if (!i.online) {
    return { kind: 'offline', pending: i.pausedCount + i.inFlightCount, lastSyncAt: i.lastSyncAt };
  }
  if (i.errorCount > 0) {
    return {
      kind: 'error',
      errorCount: i.errorCount,
      lastError: i.lastError,
      lastSyncAt: i.lastSyncAt,
    };
  }
  if (i.inFlightCount > 0) {
    return { kind: 'syncing', count: i.inFlightCount, lastSyncAt: i.lastSyncAt };
  }
  return { kind: 'synced', lastSyncAt: i.lastSyncAt };
}

/**
 * Canonical badge copy. Fixed here so a future mobile/PWA surface mirrors the
 * vocabulary verbatim (issue 374 acceptance: "component shape and vocabulary
 * identical web↔mobile"). `label` is the compact top-bar string; `aria` is the
 * spoken/announced form.
 */
export function syncStatusPresentation(status: SyncStatus): {
  label: string;
  aria: string;
} {
  switch (status.kind) {
    case 'offline':
      return status.pending > 0
        ? {
            label: `Offline · ${status.pending} pending`,
            aria: `Offline. ${status.pending} change${status.pending === 1 ? '' : 's'} pending — they'll sync when you reconnect.`,
          }
        : {
            label: 'Offline',
            aria: "Offline. Reads work from local data; changes will sync when you reconnect.",
          };
    case 'error':
      return {
        label: 'Sync error',
        aria: `Sync error. ${status.errorCount} change${status.errorCount === 1 ? '' : 's'} failed to save. Open to retry.`,
      };
    case 'syncing':
      return {
        label: `Syncing ${status.count}`,
        aria: `Syncing ${status.count} change${status.count === 1 ? '' : 's'}.`,
      };
    case 'synced':
      return { label: 'Synced', aria: 'Synced — all changes saved.' };
  }
}

/**
 * Human "last synced 3 minutes ago" text. Coarse by design — the point is
 * reassurance, not a precise clock.
 */
export function formatLastSync(lastSyncAt: number | null, now: number = Date.now()): string {
  if (lastSyncAt === null) return 'Not synced yet';
  const seconds = Math.max(0, Math.round((now - lastSyncAt) / 1000));
  if (seconds < 10) return 'Last synced just now';
  if (seconds < 60) return `Last synced ${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last synced ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `Last synced ${days} day${days === 1 ? '' : 's'} ago`;
}
