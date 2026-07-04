import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncStatusStore } from './syncStatusStore';

describe('syncStatusStore', () => {
  beforeEach(() => {
    useSyncStatusStore.setState({ lastSyncAt: null, pendingPeak: 0 });
  });

  it('stamps lastSyncAt on markSynced', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    useSyncStatusStore.getState().markSynced();
    expect(useSyncStatusStore.getState().lastSyncAt).toBe(1_700_000_000_000);
    vi.restoreAllMocks();
  });

  it('grows pendingPeak monotonically while writes are outstanding', () => {
    const { reportPending } = useSyncStatusStore.getState();
    reportPending(2);
    expect(useSyncStatusStore.getState().pendingPeak).toBe(2);
    reportPending(5);
    expect(useSyncStatusStore.getState().pendingPeak).toBe(5);
    // A dip mid-drain does not shrink the peak — progress is measured from it.
    reportPending(3);
    expect(useSyncStatusStore.getState().pendingPeak).toBe(5);
  });

  it('resets pendingPeak to 0 once the queue drains empty', () => {
    const { reportPending } = useSyncStatusStore.getState();
    reportPending(4);
    reportPending(0);
    expect(useSyncStatusStore.getState().pendingPeak).toBe(0);
  });
});
