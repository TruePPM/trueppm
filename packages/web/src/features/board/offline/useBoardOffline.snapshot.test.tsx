/**
 * The offline board snapshot must not persist a guess (#3214, the #3213 shape).
 *
 * `['tasks']`, `['dependencies']` and `['boardConfig']` are three independent
 * queries. The persist callback is driven by the query cache, so it routinely runs
 * while some of them are still in flight. `putBoardSnapshot` is a whole-record
 * `db.put` keyed on projectId, so a `?? []` there does not merely record an
 * incomplete snapshot — it OVERWRITES the last good one with an empty answer, and
 * the seed effect feeds that back in as fact on the next offline open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Task, TaskLink } from '@/types';

const { putBoardSnapshotMock, getBoardSnapshotMock } = vi.hoisted(() => ({
  putBoardSnapshotMock: vi.fn().mockResolvedValue(undefined),
  getBoardSnapshotMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./cardStatusQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cardStatusQueue')>()),
  putBoardSnapshot: putBoardSnapshotMock,
  getBoardSnapshot: getBoardSnapshotMock,
  getAllQueuedOps: vi.fn().mockResolvedValue([]),
}));

import { useBoardOffline } from './useBoardOffline';

const PID = 'p1';

const TASKS = [{ id: 't1', name: 'Draft', status: 'NOT_STARTED' }] as unknown as Task[];
const DEPS = [{ id: 'd1', predecessorId: 't1', successorId: 't2' }] as unknown as TaskLink[];
const CONFIG = [{ status: 'NOT_STARTED', label: 'To do' }] as unknown as {
  status: string;
  label: string;
}[];

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** A client seeded with whichever of the three queries have "answered". */
function seed(opts: { tasks?: Task[]; deps?: TaskLink[]; config?: unknown[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.tasks) qc.setQueryData(['tasks', PID], opts.tasks);
  if (opts.deps) qc.setQueryData(['dependencies', PID], opts.deps);
  if (opts.config) qc.setQueryData(['boardConfig', PID], opts.config);
  return qc;
}

describe('useBoardOffline — the snapshot waits for every query to answer (#3214)', () => {
  beforeEach(() => {
    putBoardSnapshotMock.mockClear();
    getBoardSnapshotMock.mockClear();
  });

  it('does not persist a snapshot while the dependencies query is unanswered', () => {
    // The regression: tasks settle first (they are a separate multi-page fetch),
    // the persist callback fires on the tasks event, and `?? []` records "this
    // project has no dependencies". `db.put` then clobbers the last good snapshot,
    // and the next offline open seeds the cache with that empty answer — a board
    // with every dependency edge silently missing.
    const qc = seed({ tasks: TASKS, config: CONFIG });

    renderHook(() => useBoardOffline(PID), { wrapper: wrapperFor(qc) });

    expect(putBoardSnapshotMock).not.toHaveBeenCalled();
  });

  it('does not persist a snapshot while the board-config query is unanswered', () => {
    // Same effect, spelled `?? null` rather than `?? []` — it falls outside a
    // literal `?? []` grep but is the identical defect: an unanswered config
    // overwrites a persisted column layout with null, and the seed effect then
    // declines to restore any config at all.
    const qc = seed({ tasks: TASKS, deps: DEPS });

    renderHook(() => useBoardOffline(PID), { wrapper: wrapperFor(qc) });

    expect(putBoardSnapshotMock).not.toHaveBeenCalled();
  });

  it('persists once all three have answered — the guard delays the write, it does not disable it', () => {
    // The other half. Without this, a guard that simply never persisted would pass
    // both assertions above while silently disabling offline seeding entirely.
    const qc = seed({ tasks: TASKS, deps: DEPS, config: CONFIG });

    renderHook(() => useBoardOffline(PID), { wrapper: wrapperFor(qc) });

    expect(putBoardSnapshotMock).toHaveBeenCalledTimes(1);
    expect(putBoardSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PID, tasks: TASKS, dependencies: DEPS }),
    );
  });

  it('persists a genuinely empty dependency list — an empty ANSWER is still an answer', () => {
    // The distinction the whole rule turns on: `[]` from a settled query is real
    // data and must be recorded. A guard keyed on `.length` instead of on
    // undefined would fail this and quietly stop snapshotting dependency-free
    // projects.
    const qc = seed({ tasks: TASKS, deps: [], config: CONFIG });

    renderHook(() => useBoardOffline(PID), { wrapper: wrapperFor(qc) });

    expect(putBoardSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ dependencies: [] }),
    );
  });

  it('persists when a late dependencies answer lands after the last tasks event', () => {
    // Guarding alone would have turned the delay into a silent disable: the
    // callback used to be subscribed to the tasks key only, so a deps answer
    // arriving after the final tasks event would never re-trigger the write and
    // NO snapshot would ever be stored. The subscription covers all three keys.
    const qc = seed({ tasks: TASKS, config: CONFIG });

    renderHook(() => useBoardOffline(PID), { wrapper: wrapperFor(qc) });
    expect(putBoardSnapshotMock).not.toHaveBeenCalled();

    qc.setQueryData(['dependencies', PID], DEPS);

    expect(putBoardSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ dependencies: DEPS }),
    );
  });
});
