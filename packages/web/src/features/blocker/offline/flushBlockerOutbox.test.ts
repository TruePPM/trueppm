import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { QueuedBlockerOp } from './blockerQueue';

// Standalone hoisted mocks so assertions reference plain vi.fn()s, not object
// methods (which trip @typescript-eslint/unbound-method).
const { patchMock, handleSyncConflictMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  handleSyncConflictMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));
vi.mock('@/api/conflict', () => ({ handleSyncConflict: handleSyncConflictMock }));
vi.mock('./blockerQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./blockerQueue')>()),
  putQueuedBlockerOp: vi.fn().mockResolvedValue(undefined),
  deleteQueuedBlockerOp: vi.fn().mockResolvedValue(undefined),
  getAllQueuedBlockerOps: vi.fn().mockResolvedValue([]),
}));

import { flushBlockerOutbox } from './useBlockerOffline';
import { useBlockerOutboxStore } from './blockerOutboxStore';

function op(partial: Partial<QueuedBlockerOp> = {}): QueuedBlockerOp {
  return {
    projectId: 'p1',
    taskId: 't1',
    kind: 'flag',
    reason: 'inspector no-show',
    blockerType: 'vendor',
    blockingTask: null,
    baseServerVersion: 3,
    wasFlagged: false,
    queuedAt: 100,
    ...partial,
  };
}

function seed(...ops: QueuedBlockerOp[]) {
  const opsByTask: Record<string, QueuedBlockerOp> = {};
  for (const o of ops) opsByTask[o.taskId] = o;
  useBlockerOutboxStore.setState({ opsByTask, hydrated: true, lastSynced: null });
}

describe('flushBlockerOutbox', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    useBlockerOutboxStore.setState({ opsByTask: {}, hydrated: true, lastSynced: null });
    client = new QueryClient();
  });

  it('is a no-op when the queue is empty', async () => {
    await flushBlockerOutbox(client);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('replays the flag PATCH with X-Base-Version, removes the op, and marks synced', async () => {
    patchMock.mockResolvedValue({ data: {} });
    seed(op());
    await flushBlockerOutbox(client);
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/t1/',
      { blocked_reason: 'inspector no-show', blocker_type: 'vendor', blocking_task: null },
      { headers: { 'X-Base-Version': '3' } },
    );
    expect(useBlockerOutboxStore.getState().opsByTask['t1']).toBeUndefined();
    expect(useBlockerOutboxStore.getState().lastSynced?.taskId).toBe('t1');
  });

  it('omits the X-Base-Version header when no base version was captured', async () => {
    patchMock.mockResolvedValue({ data: {} });
    seed(op({ baseServerVersion: null }));
    await flushBlockerOutbox(client);
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/t1/',
      expect.any(Object),
      undefined,
    );
  });

  it('yields to the server on a 409 blocker-field conflict: drop the op, no synced signal', async () => {
    patchMock.mockRejectedValue(new Error('409'));
    handleSyncConflictMock.mockReturnValue(true);
    seed(op());
    await flushBlockerOutbox(client);
    expect(handleSyncConflictMock).toHaveBeenCalledOnce();
    expect(useBlockerOutboxStore.getState().opsByTask['t1']).toBeUndefined();
    expect(useBlockerOutboxStore.getState().lastSynced).toBeNull();
  });

  it('keeps the op queued on a transient (non-conflict) error for the next flush', async () => {
    patchMock.mockRejectedValue(new Error('network down'));
    handleSyncConflictMock.mockReturnValue(false);
    seed(op());
    await flushBlockerOutbox(client);
    expect(useBlockerOutboxStore.getState().opsByTask['t1']).toBeDefined();
  });
});
