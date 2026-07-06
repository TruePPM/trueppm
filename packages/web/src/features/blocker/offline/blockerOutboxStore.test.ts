import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueuedBlockerOp } from './blockerQueue';

// Stub the IndexedDB data layer; the store's contract is "mirror in memory + write
// through". We assert the write-through calls, not IndexedDB itself.
vi.mock('./blockerQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./blockerQueue')>()),
  putQueuedBlockerOp: vi.fn().mockResolvedValue(undefined),
  deleteQueuedBlockerOp: vi.fn().mockResolvedValue(undefined),
  getAllQueuedBlockerOps: vi.fn().mockResolvedValue([]),
}));

import { useBlockerOutboxStore } from './blockerOutboxStore';
import {
  putQueuedBlockerOp,
  deleteQueuedBlockerOp,
  getAllQueuedBlockerOps,
} from './blockerQueue';

function op(partial: Partial<QueuedBlockerOp> = {}): QueuedBlockerOp {
  return {
    projectId: 'p1',
    taskId: 't1',
    kind: 'flag',
    reason: 'inspector no-show',
    blockerType: 'vendor',
    blockingTask: null,
    baseServerVersion: 1,
    wasFlagged: false,
    queuedAt: 100,
    ...partial,
  };
}

describe('blockerOutboxStore', () => {
  beforeEach(() => {
    useBlockerOutboxStore.setState({ opsByTask: {}, hydrated: false, lastSynced: null });
    vi.clearAllMocks();
  });

  it('enqueue mirrors in memory and writes through to IndexedDB', async () => {
    await useBlockerOutboxStore.getState().enqueue(op());
    expect(useBlockerOutboxStore.getState().opsByTask['t1']).toBeDefined();
    expect(putQueuedBlockerOp).toHaveBeenCalledOnce();
  });

  it('enqueue is last-write-wins per task', async () => {
    await useBlockerOutboxStore.getState().enqueue(op({ reason: 'first' }));
    await useBlockerOutboxStore.getState().enqueue(op({ reason: 'second' }));
    expect(Object.keys(useBlockerOutboxStore.getState().opsByTask)).toHaveLength(1);
    expect(useBlockerOutboxStore.getState().opsByTask['t1'].reason).toBe('second');
  });

  it('remove clears the mirror and deletes from IndexedDB', async () => {
    await useBlockerOutboxStore.getState().enqueue(op());
    await useBlockerOutboxStore.getState().remove('t1');
    expect(useBlockerOutboxStore.getState().opsByTask['t1']).toBeUndefined();
    expect(deleteQueuedBlockerOp).toHaveBeenCalledWith('t1');
  });

  it('hydrate loads persisted ops once', async () => {
    vi.mocked(getAllQueuedBlockerOps).mockResolvedValueOnce([op({ taskId: 't9' })]);
    await useBlockerOutboxStore.getState().hydrate();
    expect(useBlockerOutboxStore.getState().opsByTask['t9']).toBeDefined();
    expect(useBlockerOutboxStore.getState().hydrated).toBe(true);
    // Second call is a no-op (already hydrated).
    await useBlockerOutboxStore.getState().hydrate();
    expect(getAllQueuedBlockerOps).toHaveBeenCalledOnce();
  });

  it('markSynced records the task and timestamp for the synced announcement', () => {
    useBlockerOutboxStore.getState().markSynced('t1');
    expect(useBlockerOutboxStore.getState().lastSynced?.taskId).toBe('t1');
    expect(typeof useBlockerOutboxStore.getState().lastSynced?.at).toBe('number');
  });
});
