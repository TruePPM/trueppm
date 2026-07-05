import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Task } from '@/types';

// Standalone hoisted mocks so assertions reference plain vi.fn()s, not object
// methods (which trip @typescript-eslint/unbound-method).
const { patchMock, toastMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  toastMock: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warm: vi.fn() },
}));

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));
vi.mock('./cardStatusQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cardStatusQueue')>()),
  putQueuedOp: vi.fn().mockResolvedValue(undefined),
  deleteQueuedOp: vi.fn().mockResolvedValue(undefined),
  getAllQueuedOps: vi.fn().mockResolvedValue([]),
}));

import { flushBoardOutbox } from './useBoardOffline';
import { useBoardOutboxStore } from './boardOutboxStore';

const PID = 'p1';

function serverTask(id: string, version: number, name = id): Task {
  // Only the fields flushBoardOutbox reads matter here.
  return { id, name, status: 'NOT_STARTED', serverVersion: version } as unknown as Task;
}

/** A QueryClient whose refetch is a no-op — the test seeds "server truth" directly. */
function makeClient(serverTasks: Task[]) {
  const qc = new QueryClient();
  qc.setQueryData(['tasks', PID], serverTasks);
  const refetchSpy = vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined as never);
  vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined as never);
  return { qc, refetchSpy };
}

describe('flushBoardOutbox', () => {
  beforeEach(() => {
    useBoardOutboxStore.setState({ opsByTask: {}, hydrated: true });
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: {} });
  });

  it('replays a non-conflicting queued move and drains the queue', async () => {
    useBoardOutboxStore.setState({
      opsByTask: {
        t1: { taskId: 't1', projectId: PID, status: 'REVIEW', baseServerVersion: 2, queuedAt: 100 },
      },
    });
    const { qc } = makeClient([serverTask('t1', 2)]); // server unchanged since queue

    await flushBoardOutbox(qc, PID);

    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'REVIEW' });
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(useBoardOutboxStore.getState().opsByTask['t1']).toBeUndefined();
  });

  it('surfaces a conflict toast and drops the op when the server version advanced', async () => {
    useBoardOutboxStore.setState({
      opsByTask: {
        t1: { taskId: 't1', projectId: PID, status: 'REVIEW', baseServerVersion: 2, queuedAt: 100 },
      },
    });
    const { qc } = makeClient([serverTask('t1', 5, 'Pour foundation')]); // advanced 2 -> 5

    await flushBoardOutbox(qc, PID);

    expect(patchMock).not.toHaveBeenCalled();
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining('Pour foundation'));
    expect(useBoardOutboxStore.getState().opsByTask['t1']).toBeUndefined();
  });

  it('only replays the latest move per task (LWW) and scopes to the project', async () => {
    useBoardOutboxStore.setState({
      opsByTask: {
        t1: { taskId: 't1', projectId: PID, status: 'REVIEW', baseServerVersion: 1, queuedAt: 200 },
        other: {
          taskId: 'other',
          projectId: 'other-project',
          status: 'COMPLETE',
          baseServerVersion: 1,
          queuedAt: 150,
        },
      },
    });
    const { qc } = makeClient([serverTask('t1', 1)]);

    await flushBoardOutbox(qc, PID);

    // t1 replayed; the other-project op is left untouched for its own board.
    expect(patchMock).toHaveBeenCalledOnce();
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'REVIEW' });
    expect(useBoardOutboxStore.getState().opsByTask['other']).toBeDefined();
  });

  it('is a no-op when nothing is queued for the project', async () => {
    const { qc, refetchSpy } = makeClient([serverTask('t1', 1)]);
    await flushBoardOutbox(qc, PID);
    expect(refetchSpy).not.toHaveBeenCalled();
    expect(patchMock).not.toHaveBeenCalled();
  });
});
