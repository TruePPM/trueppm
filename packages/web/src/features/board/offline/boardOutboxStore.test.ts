import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueuedCardStatusOp } from './cardStatusQueue';

// Stub the IndexedDB data layer; the store's contract is "mirror in memory + write
// through". We assert the write-through calls, not IndexedDB itself.
vi.mock('./cardStatusQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cardStatusQueue')>()),
  putQueuedOp: vi.fn().mockResolvedValue(undefined),
  deleteQueuedOp: vi.fn().mockResolvedValue(undefined),
  getAllQueuedOps: vi.fn().mockResolvedValue([]),
}));

import { useBoardOutboxStore } from './boardOutboxStore';
import { putQueuedOp, deleteQueuedOp, getAllQueuedOps } from './cardStatusQueue';

function op(partial: Partial<QueuedCardStatusOp> = {}): QueuedCardStatusOp {
  return {
    taskId: 't1',
    projectId: 'p1',
    status: 'IN_PROGRESS',
    baseServerVersion: 1,
    queuedAt: 100,
    ...partial,
  };
}

describe('boardOutboxStore', () => {
  beforeEach(() => {
    useBoardOutboxStore.setState({ opsByTask: {}, hydrated: false });
    vi.clearAllMocks();
  });

  it('enqueue mirrors in memory and writes through to IndexedDB', async () => {
    await useBoardOutboxStore.getState().enqueue(op());
    expect(useBoardOutboxStore.getState().opsByTask['t1']?.status).toBe('IN_PROGRESS');
    expect(putQueuedOp).toHaveBeenCalledOnce();
  });

  it('enqueue overwrites the same task (last-write-wins)', async () => {
    await useBoardOutboxStore.getState().enqueue(op({ status: 'NOT_STARTED', queuedAt: 100 }));
    await useBoardOutboxStore.getState().enqueue(op({ status: 'REVIEW', queuedAt: 200 }));
    expect(Object.keys(useBoardOutboxStore.getState().opsByTask)).toEqual(['t1']);
    expect(useBoardOutboxStore.getState().opsByTask['t1'].status).toBe('REVIEW');
  });

  it('remove clears the mirror and deletes from IndexedDB', async () => {
    await useBoardOutboxStore.getState().enqueue(op());
    await useBoardOutboxStore.getState().remove('t1');
    expect(useBoardOutboxStore.getState().opsByTask['t1']).toBeUndefined();
    expect(deleteQueuedOp).toHaveBeenCalledWith('t1');
  });

  it('hydrate loads persisted ops once', async () => {
    vi.mocked(getAllQueuedOps).mockResolvedValueOnce([op({ taskId: 'a' }), op({ taskId: 'b' })]);
    await useBoardOutboxStore.getState().hydrate();
    expect(Object.keys(useBoardOutboxStore.getState().opsByTask).sort()).toEqual(['a', 'b']);
    expect(useBoardOutboxStore.getState().hydrated).toBe(true);
    // Second call is a no-op (already hydrated).
    await useBoardOutboxStore.getState().hydrate();
    expect(getAllQueuedOps).toHaveBeenCalledOnce();
  });
});
