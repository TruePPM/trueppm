import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  createTaskRowSplicer,
  isSpliceableChange,
  TASK_SPLICE_COALESCE_MS,
  TASK_SPLICE_CONCURRENCY,
  TASK_SPLICE_MAX_BURST,
} from './taskRowSplice';
import type { ApiTask } from './useScheduleTasks';
import type { Task } from '@/types';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function api(id: string, name: string, serverVersion: number): ApiTask {
  return { id, name, server_version: serverVersion, is_summary: false } as unknown as ApiTask;
}
function row(id: string, name: string, serverVersion: number): Task {
  return { id, name, serverVersion, wbs: `W-${id}` } as unknown as Task;
}

describe('isSpliceableChange', () => {
  it('accepts plain fields and rejects missing/empty/structural lists', () => {
    expect(isSpliceableChange(['name', 'labels'])).toBe(true);
    // owners upserts TaskResource rows, which can flip other tasks' overallocation.
    expect(isSpliceableChange(['name', 'owners'])).toBe(false);
    expect(isSpliceableChange(['percent_complete'])).toBe(false);
    expect(isSpliceableChange(['name', 'status'])).toBe(false);
    for (const f of [
      'structure_role',
      'auto_container',
      'deleted_at',
      'duration',
      'sprint',
      'blocked_by',
      'assignee',
      'some_new_field',
    ]) {
      expect(isSpliceableChange([f])).toBe(false);
    }
    expect(isSpliceableChange(undefined)).toBe(false);
    expect(isSpliceableChange([])).toBe(false);
    expect(isSpliceableChange(['name', 'parent'])).toBe(false);
    expect(isSpliceableChange(['wbs_path'])).toBe(false);
    expect(isSpliceableChange(['sort_order'])).toBe(false);
    expect(isSpliceableChange(['board_rank'])).toBe(false);
  });
});

describe('createTaskRowSplicer', () => {
  let qc: QueryClient;
  let fallback: ReturnType<typeof vi.fn<() => void>>;
  const make = () => createTaskRowSplicer({ queryClient: qc, getProjectId: () => 'p1', fallback });
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(TASK_SPLICE_COALESCE_MS + 1);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    getMock.mockReset();
    fallback = vi.fn<() => void>();
    qc = new QueryClient();
    qc.setQueryData<Task[]>(['tasks', 'p1'], [row('a', 'A', 1), row('b', 'B', 1)]);
  });
  afterEach(() => vi.useRealTimers());

  it('splices one row with a single GET and no fallback, keeping the client wbs', async () => {
    getMock.mockResolvedValue({ data: api('a', 'A2', 2) });
    make().request('a', 2);
    await flush();
    expect(getMock).toHaveBeenCalledTimes(1);
    // project= is required for the server to annotate the baseline overlay.
    expect(getMock).toHaveBeenCalledWith(
      '/tasks/a/',
      expect.objectContaining({ params: { project: 'p1' } }),
    );
    const rows = qc.getQueryData<Task[]>(['tasks', 'p1'])!;
    expect(rows[0]).toMatchObject({ name: 'A2', serverVersion: 2, wbs: 'W-a' });
    expect(rows[1].name).toBe('B');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps the baseline overlay from the project-scoped read', async () => {
    getMock.mockResolvedValue({
      data: { ...api('a', 'A2', 2), baseline_start: '2026-01-05', baseline_finish: '2026-01-09' },
    });
    make().request('a', 2);
    await flush();
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])![0]).toMatchObject({
      baselineStart: '2026-01-05',
    });
  });

  it('coalesces frames for the same id into one GET', async () => {
    getMock.mockResolvedValue({ data: api('a', 'A3', 3) });
    const s = make();
    s.request('a', 2);
    s.request('a', 3);
    s.request('a', 3);
    await flush();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('bounds in-flight GETs', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      ids.map((i) => row(i, i, 1)),
    );
    let inFlight = 0;
    let peak = 0;
    getMock.mockImplementation(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { data: api(url.split('/')[2], 'x', 2) };
    });
    const s = make();
    ids.forEach((i) => s.request(i, 2));
    await vi.advanceTimersByTimeAsync(TASK_SPLICE_COALESCE_MS + 200);
    expect(getMock).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(TASK_SPLICE_CONCURRENCY);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to one list refetch (no GETs) for a bulk burst', async () => {
    const s = make();
    for (let i = 0; i <= TASK_SPLICE_MAX_BURST; i++) s.request(`t${i}`, 2);
    await flush();
    expect(getMock).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when the GET fails (404 / network)', async () => {
    getMock.mockRejectedValue(new Error('404'));
    make().request('a', 2);
    await flush();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])![0].name).toBe('A');
  });

  it('falls back when the row is no longer cached', async () => {
    getMock.mockResolvedValue({ data: api('zzz', 'Z', 2) });
    make().request('zzz', 2);
    await flush();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('drops a read older than the cached row without falling back', async () => {
    qc.setQueryData<Task[]>(['tasks', 'p1'], [row('a', 'newer', 5)]);
    getMock.mockResolvedValue({ data: api('a', 'older', 3) });
    make().request('a', 3);
    await flush();
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])![0].name).toBe('newer');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back when the read is older than the announcing frame', async () => {
    getMock.mockResolvedValue({ data: api('a', 'lagging', 2) });
    make().request('a', 4);
    await flush();
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])![0].name).toBe('A');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('never exceeds the concurrency bound across consecutive flush windows', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      ids.map((i) => row(i, i, 1)),
    );
    let inFlight = 0;
    let peak = 0;
    getMock.mockImplementation(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 400)); // outlives several 100 ms windows
      inFlight--;
      return { data: api(url.split('/')[2], 'x', 2) };
    });
    const s = make();
    s.request('t0', 2);
    s.request('t1', 2);
    s.request('t2', 2);
    await vi.advanceTimersByTimeAsync(TASK_SPLICE_COALESCE_MS + 1);
    for (const i of ids.slice(3)) s.request(i, 2);
    await vi.advanceTimersByTimeAsync(TASK_SPLICE_COALESCE_MS * 2);
    s.request('t0', 3); // already in flight: waits, never runs concurrently
    await vi.advanceTimersByTimeAsync(5000);
    expect(peak).toBeLessThanOrEqual(TASK_SPLICE_CONCURRENCY);
    expect(getMock.mock.calls.filter(([u]) => u === '/tasks/t0/')).toHaveLength(2);
  });

  it('splices a frame that carries no version', async () => {
    getMock.mockResolvedValue({ data: api('a', 'A2', 2) });
    make().request('a', null);
    await flush();
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])![0].name).toBe('A2');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('discards a late GET after dispose (no splice, no fallback)', async () => {
    let resolve!: (v: unknown) => void;
    getMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const s = make();
    s.request('a', 2);
    await flush();
    s.dispose();
    resolve({ data: api('a', 'Late', 2) });
    await vi.advanceTimersByTimeAsync(10);
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])![0].name).toBe('A');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('dispose cancels pending work', async () => {
    const s = make();
    s.request('a', 2);
    s.dispose();
    await flush();
    expect(getMock).not.toHaveBeenCalled();
  });
});
