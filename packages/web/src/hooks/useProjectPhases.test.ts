/**
 * useProjectPhases unit tests (#2459 coverage backfill, #521 / ADR-0046).
 *
 * The hook is the Project Settings → Workflow page's whole data layer, and each
 * of its four mutations resolves its own cache branch rather than refetching
 * blindly. The behaviors that must not silently regress:
 *  - the query is gated on projectId, so an unresolved route never fires a
 *    request against `/projects/undefined/phases/`;
 *  - the snake_case API row is mapped to the camelCase ProjectPhase the UI reads;
 *  - create sends an explicit null color (the server distinguishes null from
 *    absent) and invalidates so the new row picks up its server-assigned rank;
 *  - update/remove patch the cached list in place — only the touched row moves,
 *    and neither may throw when the list has not loaded yet;
 *  - reorder rebuilds the ADR-0046 body (id + server_version) from the cached
 *    rows, dropping ids it has no version for rather than sending a bad lock.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useProjectPhases, type ProjectPhase } from './useProjectPhases';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface ApiPhaseRow {
  id: string;
  name: string;
  color: string | null;
  priority_rank: number | null;
  wbs_path: string | null;
  task_count: number;
  server_version: number;
}

function apiRow(overrides: Partial<ApiPhaseRow> = {}): ApiPhaseRow {
  return {
    id: 'ph1',
    name: 'Design',
    color: '#3355FF',
    priority_rank: 1,
    wbs_path: '1',
    task_count: 4,
    server_version: 2,
    ...overrides,
  };
}

/** Renders the hook against a resolved two-phase list and waits for it to land. */
async function renderLoaded(qc: QueryClient, rows: ApiPhaseRow[]) {
  getMock.mockResolvedValueOnce({ data: rows });
  const view = renderHook(() => useProjectPhases('p1'), { wrapper: makeWrapper(qc) });
  await waitFor(() => expect(view.result.current.phases).toHaveLength(rows.length));
  return view;
}

/** A request that never settles — lets a mutation resolve before the list does. */
function pendingForever() {
  return new Promise<never>(() => {});
}

const TWO_ROWS = [
  apiRow({ id: 'ph1', name: 'Design', priority_rank: 1, server_version: 2 }),
  apiRow({ id: 'ph2', name: 'Build', priority_rank: 2, server_version: 7, color: null }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProjectPhases', () => {
  describe('the phases query', () => {
    it('maps the snake_case API row onto the camelCase phase the UI reads', async () => {
      const { result } = await renderLoaded(makeQC(), [apiRow()]);

      const expected: ProjectPhase = {
        id: 'ph1',
        name: 'Design',
        color: '#3355FF',
        priorityRank: 1,
        wbsPath: '1',
        taskCount: 4,
        serverVersion: 2,
      };
      expect(result.current.phases).toEqual([expected]);
      expect(getMock).toHaveBeenCalledWith('/projects/p1/phases/');
      expect(result.current.error).toBeNull();
    });

    it('preserves null color, rank, and wbs path rather than coercing them', async () => {
      const { result } = await renderLoaded(makeQC(), [
        apiRow({ color: null, priority_rank: null, wbs_path: null, task_count: 0 }),
      ]);

      expect(result.current.phases[0]).toMatchObject({
        color: null,
        priorityRank: null,
        wbsPath: null,
        taskCount: 0,
      });
    });

    it('does not fetch and reports an empty list when projectId is null', () => {
      const { result } = renderHook(() => useProjectPhases(null), {
        wrapper: makeWrapper(makeQC()),
      });

      expect(getMock).not.toHaveBeenCalled();
      expect(result.current.phases).toEqual([]);
      expect(result.current.isLoading).toBe(false);
    });

    it('does not fetch when projectId is undefined (route not resolved yet)', () => {
      const { result } = renderHook(() => useProjectPhases(undefined), {
        wrapper: makeWrapper(makeQC()),
      });

      expect(getMock).not.toHaveBeenCalled();
      expect(result.current.phases).toEqual([]);
    });

    it('reports isLoading while the first fetch is in flight', () => {
      getMock.mockReturnValueOnce(pendingForever());
      const { result } = renderHook(() => useProjectPhases('p1'), {
        wrapper: makeWrapper(makeQC()),
      });

      expect(result.current.isLoading).toBe(true);
      expect(result.current.phases).toEqual([]);
    });

    it('surfaces a fetch failure as error while keeping phases an empty array', async () => {
      const boom = new Error('500 from /phases/');
      getMock.mockRejectedValueOnce(boom);
      const { result } = renderHook(() => useProjectPhases('p1'), {
        wrapper: makeWrapper(makeQC()),
      });

      await waitFor(() => expect(result.current.error).toBe(boom));
      expect(result.current.phases).toEqual([]);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('create', () => {
    it('sends an explicit null color when the caller omits one', async () => {
      postMock.mockResolvedValueOnce({ data: apiRow({ id: 'new', name: 'Test', color: null }) });
      const { result } = await renderLoaded(makeQC(), [apiRow()]);

      result.current.create.mutate({ name: 'Test' });

      await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
      expect(postMock).toHaveBeenCalledWith('/projects/p1/phases/', {
        name: 'Test',
        color: null,
      });
      expect(result.current.create.data).toMatchObject({ id: 'new', color: null });
    });

    it('passes a chosen color through to the endpoint', async () => {
      postMock.mockResolvedValueOnce({ data: apiRow({ id: 'new', color: '#00AA88' }) });
      const { result } = await renderLoaded(makeQC(), [apiRow()]);

      result.current.create.mutate({ name: 'Rollout', color: '#00AA88' });

      await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
      expect(postMock).toHaveBeenCalledWith('/projects/p1/phases/', {
        name: 'Rollout',
        color: '#00AA88',
      });
    });

    it('refetches the list on success so the server-assigned rank is picked up', async () => {
      const qc = makeQC();
      postMock.mockResolvedValueOnce({ data: apiRow({ id: 'new' }) });
      const { result } = await renderLoaded(qc, [apiRow()]);
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      result.current.create.mutate({ name: 'Test' });

      await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-phases', 'p1'] });
    });

    it('surfaces a create failure without invalidating the list', async () => {
      const qc = makeQC();
      const rejected = new Error('name already taken');
      postMock.mockRejectedValueOnce(rejected);
      const { result } = await renderLoaded(qc, [apiRow()]);
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      result.current.create.mutate({ name: 'Design' });

      await waitFor(() => expect(result.current.create.isError).toBe(true));
      expect(result.current.create.error).toBe(rejected);
      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('replaces only the edited row in the cached list', async () => {
      patchMock.mockResolvedValueOnce({
        data: apiRow({ id: 'ph2', name: 'Build & verify', server_version: 8, color: '#112233' }),
      });
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.update.mutate({ id: 'ph2', payload: { name: 'Build & verify' } });

      await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
      expect(patchMock).toHaveBeenCalledWith('/projects/p1/phases/ph2/', {
        name: 'Build & verify',
      });
      expect(result.current.phases).toEqual([
        expect.objectContaining({ id: 'ph1', name: 'Design', serverVersion: 2 }),
        expect.objectContaining({ id: 'ph2', name: 'Build & verify', serverVersion: 8 }),
      ]);
      // No refetch — update resolves the cache in place.
      expect(getMock).toHaveBeenCalledTimes(1);
    });

    it('supports clearing the color back to null', async () => {
      patchMock.mockResolvedValueOnce({ data: apiRow({ id: 'ph1', color: null }) });
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.update.mutate({ id: 'ph1', payload: { color: null } });

      await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
      expect(patchMock).toHaveBeenCalledWith('/projects/p1/phases/ph1/', { color: null });
      expect(result.current.phases[0].color).toBeNull();
    });

    it('leaves the cache empty when the list has not loaded yet', async () => {
      getMock.mockReturnValueOnce(pendingForever());
      patchMock.mockResolvedValueOnce({ data: apiRow({ id: 'ph1', name: 'Renamed' }) });
      const { result } = renderHook(() => useProjectPhases('p1'), {
        wrapper: makeWrapper(makeQC()),
      });

      result.current.update.mutate({ id: 'ph1', payload: { name: 'Renamed' } });

      await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
      expect(result.current.phases).toEqual([]);
    });

    it('surfaces an update failure and leaves the cached row untouched', async () => {
      const conflict = new Error('409 version conflict');
      patchMock.mockRejectedValueOnce(conflict);
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.update.mutate({ id: 'ph1', payload: { name: 'Nope' } });

      await waitFor(() => expect(result.current.update.isError).toBe(true));
      expect(result.current.update.error).toBe(conflict);
      expect(result.current.phases[0].name).toBe('Design');
    });
  });

  describe('remove', () => {
    it('drops only the deleted row from the cached list', async () => {
      deleteMock.mockResolvedValueOnce({ data: null });
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.remove.mutate('ph1');

      await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
      expect(deleteMock).toHaveBeenCalledWith('/projects/p1/phases/ph1/');
      expect(result.current.phases.map((p) => p.id)).toEqual(['ph2']);
    });

    it('is a cache no-op when the list has not loaded yet', async () => {
      getMock.mockReturnValueOnce(pendingForever());
      deleteMock.mockResolvedValueOnce({ data: null });
      const { result } = renderHook(() => useProjectPhases('p1'), {
        wrapper: makeWrapper(makeQC()),
      });

      result.current.remove.mutate('ph1');

      await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
      expect(result.current.phases).toEqual([]);
    });

    it('keeps the row when the delete fails', async () => {
      const denied = new Error('403');
      deleteMock.mockRejectedValueOnce(denied);
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.remove.mutate('ph1');

      await waitFor(() => expect(result.current.remove.isError).toBe(true));
      expect(result.current.remove.error).toBe(denied);
      expect(result.current.phases.map((p) => p.id)).toEqual(['ph1', 'ph2']);
    });
  });

  describe('reorder', () => {
    it('sends id + server_version in the requested order (ADR-0046 body shape)', async () => {
      patchMock.mockResolvedValueOnce({ data: {} });
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.reorder.mutate(['ph2', 'ph1']);

      await waitFor(() => expect(result.current.reorder.isSuccess).toBe(true));
      expect(patchMock).toHaveBeenCalledWith('/projects/p1/phases/reorder/', {
        phases: [
          { id: 'ph2', server_version: 7 },
          { id: 'ph1', server_version: 2 },
        ],
      });
    });

    it('drops ids it holds no cached version for rather than sending a bad lock', async () => {
      patchMock.mockResolvedValueOnce({ data: {} });
      const { result } = await renderLoaded(makeQC(), TWO_ROWS);

      result.current.reorder.mutate(['ph2', 'ghost', 'ph1']);

      await waitFor(() => expect(result.current.reorder.isSuccess).toBe(true));
      expect(patchMock).toHaveBeenCalledWith('/projects/p1/phases/reorder/', {
        phases: [
          { id: 'ph2', server_version: 7 },
          { id: 'ph1', server_version: 2 },
        ],
      });
    });

    it('sends an empty batch when the list has not loaded yet', async () => {
      getMock.mockReturnValueOnce(pendingForever());
      patchMock.mockResolvedValueOnce({ data: {} });
      const { result } = renderHook(() => useProjectPhases('p1'), {
        wrapper: makeWrapper(makeQC()),
      });

      result.current.reorder.mutate(['ph1', 'ph2']);

      await waitFor(() => expect(result.current.reorder.isSuccess).toBe(true));
      expect(patchMock).toHaveBeenCalledWith('/projects/p1/phases/reorder/', { phases: [] });
    });

    it('refetches the list on success so ranks come back authoritative', async () => {
      const qc = makeQC();
      patchMock.mockResolvedValueOnce({ data: {} });
      const { result } = await renderLoaded(qc, TWO_ROWS);
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      result.current.reorder.mutate(['ph2', 'ph1']);

      await waitFor(() => expect(result.current.reorder.isSuccess).toBe(true));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-phases', 'p1'] });
    });

    it('surfaces a reorder failure without invalidating the list', async () => {
      const qc = makeQC();
      const conflict = new Error('409 version conflict');
      patchMock.mockRejectedValueOnce(conflict);
      const { result } = await renderLoaded(qc, TWO_ROWS);
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      result.current.reorder.mutate(['ph2', 'ph1']);

      await waitFor(() => expect(result.current.reorder.isError).toBe(true));
      expect(result.current.reorder.error).toBe(conflict);
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

  });

  /**
   * The mutations are not themselves gated on projectId (only the query is), so
   * a mutation fired from a screen whose project has gone away must never write
   * into — or invalidate — a *different* project's cached list. Each resolver
   * falls back to the empty-id key; these lock that isolation in.
   */
  describe('with no active project', () => {
    const OTHER_KEY = ['project-phases', 'p1'] as const;

    function seedOtherProject(qc: QueryClient): ProjectPhase[] {
      const cached: ProjectPhase[] = [
        {
          id: 'ph1',
          name: 'Design',
          color: null,
          priorityRank: 1,
          wbsPath: '1',
          taskCount: 0,
          serverVersion: 2,
        },
      ];
      qc.setQueryData<ProjectPhase[]>(OTHER_KEY, cached);
      return cached;
    }

    it('invalidates only the empty-id key after a create', async () => {
      const qc = makeQC();
      seedOtherProject(qc);
      postMock.mockResolvedValueOnce({ data: apiRow({ id: 'new' }) });
      const { result } = renderHook(() => useProjectPhases(null), { wrapper: makeWrapper(qc) });
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      result.current.create.mutate({ name: 'Orphan' });

      await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-phases', ''] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: OTHER_KEY });
    });

    it("leaves another project's cached list untouched on update and remove", async () => {
      const qc = makeQC();
      const cached = seedOtherProject(qc);
      patchMock.mockResolvedValueOnce({ data: apiRow({ id: 'ph1', name: 'Hijacked' }) });
      deleteMock.mockResolvedValueOnce({ data: null });
      const { result } = renderHook(() => useProjectPhases(null), { wrapper: makeWrapper(qc) });

      result.current.update.mutate({ id: 'ph1', payload: { name: 'Hijacked' } });
      await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

      result.current.remove.mutate('ph1');
      await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));

      expect(qc.getQueryData<ProjectPhase[]>(OTHER_KEY)).toEqual(cached);
    });

    it('invalidates only the empty-id key after a reorder', async () => {
      const qc = makeQC();
      seedOtherProject(qc);
      patchMock.mockResolvedValueOnce({ data: {} });
      const { result } = renderHook(() => useProjectPhases(null), { wrapper: makeWrapper(qc) });
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      result.current.reorder.mutate(['ph1']);

      await waitFor(() => expect(result.current.reorder.isSuccess).toBe(true));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-phases', ''] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: OTHER_KEY });
    });
  });
});
