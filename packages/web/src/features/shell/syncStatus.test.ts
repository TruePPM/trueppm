import { describe, expect, it } from 'vitest';
import {
  deriveSyncStatus,
  formatLastSync,
  syncStatusPresentation,
  type SyncInputs,
} from './syncStatus';

const base: SyncInputs = {
  online: true,
  inFlightCount: 0,
  pausedCount: 0,
  errorCount: 0,
  lastError: null,
  lastSyncAt: null,
  liveUpdatesDegraded: false,
};

describe('deriveSyncStatus', () => {
  it('is synced when online with no outstanding writes', () => {
    expect(deriveSyncStatus(base)).toEqual({ kind: 'synced', lastSyncAt: null });
  });

  it('is syncing with the in-flight count when writes are draining', () => {
    const status = deriveSyncStatus({ ...base, inFlightCount: 3 });
    expect(status).toEqual({ kind: 'syncing', count: 3, lastSyncAt: null });
  });

  it('is offline with paused + in-flight writes counted as pending', () => {
    const status = deriveSyncStatus({
      ...base,
      online: false,
      pausedCount: 2,
      inFlightCount: 1,
    });
    expect(status).toEqual({ kind: 'offline', pending: 3, lastSyncAt: null });
  });

  it('surfaces errors when online', () => {
    const status = deriveSyncStatus({
      ...base,
      errorCount: 1,
      lastError: '409 conflict',
    });
    expect(status).toEqual({
      kind: 'error',
      errorCount: 1,
      lastError: '409 conflict',
      lastSyncAt: null,
    });
  });

  it('gives offline precedence over error and syncing', () => {
    const status = deriveSyncStatus({
      ...base,
      online: false,
      errorCount: 2,
      inFlightCount: 1,
      pausedCount: 1,
    });
    // Offline dominates: the user cannot act on an error while offline, and the
    // queued writes are the story. Error+in-flight both fold into `pending`.
    expect(status.kind).toBe('offline');
    if (status.kind === 'offline') expect(status.pending).toBe(2);
  });

  it('gives error precedence over syncing when online', () => {
    const status = deriveSyncStatus({
      ...base,
      errorCount: 1,
      inFlightCount: 2,
    });
    expect(status.kind).toBe('error');
  });

  it('is stale when the live-update socket is degraded but the browser is online', () => {
    const status = deriveSyncStatus({ ...base, liveUpdatesDegraded: true });
    expect(status).toEqual({ kind: 'stale', lastSyncAt: null });
  });

  it('ranks stale above syncing and synced so a working write path cannot mask it', () => {
    // A draining write must not paint "Syncing"/"Synced" over a frozen view.
    const syncing = deriveSyncStatus({ ...base, liveUpdatesDegraded: true, inFlightCount: 2 });
    expect(syncing.kind).toBe('stale');
    const synced = deriveSyncStatus({ ...base, liveUpdatesDegraded: true });
    expect(synced.kind).toBe('stale');
  });

  it('ranks offline and error above stale', () => {
    // Browser offline dominates (the socket is down too, but that's implied).
    expect(deriveSyncStatus({ ...base, online: false, liveUpdatesDegraded: true }).kind).toBe(
      'offline',
    );
    // A failed write (actionable) outranks a stale read.
    expect(deriveSyncStatus({ ...base, errorCount: 1, liveUpdatesDegraded: true }).kind).toBe(
      'error',
    );
  });

  it('threads lastSyncAt through every state', () => {
    const ts = 1_700_000_000_000;
    expect(deriveSyncStatus({ ...base, lastSyncAt: ts }).lastSyncAt).toBe(ts);
    expect(deriveSyncStatus({ ...base, online: false, lastSyncAt: ts }).lastSyncAt).toBe(ts);
  });
});

describe('syncStatusPresentation', () => {
  it('renders the canonical labels for each state', () => {
    expect(syncStatusPresentation({ kind: 'synced', lastSyncAt: null }).label).toBe('Synced');
    expect(
      syncStatusPresentation({ kind: 'syncing', count: 2, lastSyncAt: null }).label,
    ).toBe('Syncing 2');
    expect(
      syncStatusPresentation({ kind: 'offline', pending: 3, lastSyncAt: null }).label,
    ).toBe('Offline · 3 pending');
    expect(
      syncStatusPresentation({ kind: 'offline', pending: 0, lastSyncAt: null }).label,
    ).toBe('Offline');
    expect(
      syncStatusPresentation({
        kind: 'error',
        errorCount: 1,
        lastError: null,
        lastSyncAt: null,
      }).label,
    ).toBe('Sync error');
    expect(syncStatusPresentation({ kind: 'stale', lastSyncAt: null }).label).toBe('Not live');
  });

  it('the stale aria reassures that writes still save', () => {
    const { aria } = syncStatusPresentation({ kind: 'stale', lastSyncAt: null });
    expect(aria).toContain('out of date');
    expect(aria).toContain('changes still save');
  });

  it('singularizes the pending count in aria text', () => {
    const { aria } = syncStatusPresentation({ kind: 'offline', pending: 1, lastSyncAt: null });
    expect(aria).toContain('1 change pending');
  });
});

describe('formatLastSync', () => {
  const now = 1_700_000_000_000;

  it('reports "Not synced yet" when never synced', () => {
    expect(formatLastSync(null, now)).toBe('Not synced yet');
  });

  it('reports "just now" within 10 seconds', () => {
    expect(formatLastSync(now - 3_000, now)).toBe('Last synced just now');
  });

  it('reports seconds, minutes, hours, and days', () => {
    expect(formatLastSync(now - 30_000, now)).toBe('Last synced 30 seconds ago');
    expect(formatLastSync(now - 2 * 60_000, now)).toBe('Last synced 2 minutes ago');
    expect(formatLastSync(now - 3 * 3_600_000, now)).toBe('Last synced 3 hours ago');
    expect(formatLastSync(now - 2 * 86_400_000, now)).toBe('Last synced 2 days ago');
  });

  it('singularizes 1 minute', () => {
    expect(formatLastSync(now - 60_000, now)).toBe('Last synced 1 minute ago');
  });
});
