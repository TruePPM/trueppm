/**
 * useRetroBoard unit tests (#784 coverage backfill, ADR-0117 §1/§3/§5).
 *
 * The live retro board + team-health pulse hooks are dense with optimistic
 * cache logic a stale regression would silently corrupt:
 *  - useCreateBoardItem inserts an optimistic placeholder keyed by the caller's
 *    tempId, rolls it back on error, and swaps tempId → server row in place on
 *    success (the card never flickers out);
 *  - useUpdateBoardItem / useDeleteBoardItem optimistically patch/remove and roll
 *    back to the pre-mutation snapshot on error;
 *  - useConvertStickyToAction invalidates both the board and the retro reads;
 *  - usePulse translates a 204 into a sentinel null;
 *  - useUpsertPulse optimistically writes the answer, rolls back on error, and
 *    refetches the privacy-gated trend on success;
 *  - usePulseTrend passes the {gated} discriminated union through untouched.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useRetroBoard,
  useCreateBoardItem,
  useUpdateBoardItem,
  useDeleteBoardItem,
  useConvertStickyToAction,
  usePulse,
  useUpsertPulse,
  usePulseTrend,
  type RetroBoardItem,
  type RetroBoardResponse,
  type PulseResponse,
} from './useRetroBoard';

const { getMock, postMock, patchMock, deleteMock, putMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
    put: putMock,
  },
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

const boardKey = (sprintId: string) => ['sprint', sprintId, 'retro-board'];
const pulseKey = (sprintId: string) => ['sprint', sprintId, 'pulse'];

function item(overrides: Partial<RetroBoardItem> = {}): RetroBoardItem {
  return {
    id: 'i1',
    retro: 'r1',
    column: 'went_well',
    text: 'Shipped it',
    author: 1,
    author_username: 'alice',
    position: 1,
    color: '',
    converted_action_item_id: null,
    created_at: '2026-06-25T00:00:00Z',
    updated_at: '2026-06-25T00:00:00Z',
    ...overrides,
  };
}

function board(items: RetroBoardItem[]): RetroBoardResponse {
  return {
    columns: [
      { key: 'went_well', label: 'Went well' },
      { key: 'to_improve', label: 'To improve' },
      { key: 'ideas', label: 'Ideas' },
    ],
    items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useRetroBoard query', () => {
  it('fetches the board for the sprint', async () => {
    getMock.mockResolvedValueOnce({ data: board([item()]) });
    const qc = makeQC();
    const { result } = renderHook(() => useRetroBoard('s1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/sprints/s1/retro-board/');
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('does not fetch when the sprintId is null (enabled gate)', () => {
    const qc = makeQC();
    renderHook(() => useRetroBoard(null), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useCreateBoardItem', () => {
  it('optimistically inserts a placeholder keyed by tempId before the request resolves', async () => {
    postMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(boardKey('s1'), board([]));
    const { result } = renderHook(() => useCreateBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ column: 'ideas', text: 'New idea', tempId: 'tmp-1' });

    await waitFor(() => {
      const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
      expect(cached?.items.map((i) => i.id)).toContain('tmp-1');
    });
    expect(postMock).toHaveBeenCalledWith('/sprints/s1/retro-board/', {
      column: 'ideas',
      text: 'New idea',
    });
  });

  it('includes color in the POST body only when provided', async () => {
    postMock.mockResolvedValueOnce({ data: item({ id: 'real-1' }) });
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(boardKey('s1'), board([]));
    const { result } = renderHook(() => useCreateBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ column: 'ideas', text: 'New idea', color: 'amber', tempId: 'tmp-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/s1/retro-board/', {
      column: 'ideas',
      text: 'New idea',
      color: 'amber',
    });
  });

  it('swaps the placeholder for the server row in place on success', async () => {
    postMock.mockResolvedValueOnce({ data: item({ id: 'real-1', text: 'New idea' }) });
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(boardKey('s1'), board([]));
    const { result } = renderHook(() => useCreateBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ column: 'ideas', text: 'New idea', tempId: 'tmp-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
    expect(cached?.items.map((i) => i.id)).toEqual(['real-1']);
    expect(cached?.items.map((i) => i.id)).not.toContain('tmp-1');
  });

  it('rolls the placeholder back when the POST fails', async () => {
    postMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(boardKey('s1'), board([item({ id: 'existing' })]));
    const { result } = renderHook(() => useCreateBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ column: 'ideas', text: 'New idea', tempId: 'tmp-1' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
    expect(cached?.items.map((i) => i.id)).toEqual(['existing']);
  });
});

describe('useUpdateBoardItem', () => {
  it('optimistically patches the cached sticky before the request resolves', async () => {
    patchMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(boardKey('s1'), board([item({ id: 'i1', text: 'old' })]));
    const { result } = renderHook(() => useUpdateBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 'i1', text: 'edited' });

    await waitFor(() => {
      const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
      expect(cached?.items[0].text).toBe('edited');
    });
    expect(patchMock).toHaveBeenCalledWith('/retro-items/i1/', { text: 'edited' });
  });

  it('rolls back to the snapshot when the PATCH fails', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(boardKey('s1'), board([item({ id: 'i1', text: 'old' })]));
    const { result } = renderHook(() => useUpdateBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 'i1', column: 'to_improve' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
    expect(cached?.items[0]).toMatchObject({ text: 'old', column: 'went_well' });
  });
});

describe('useDeleteBoardItem', () => {
  it('optimistically removes the sticky before the request resolves', async () => {
    deleteMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(
      boardKey('s1'),
      board([item({ id: 'i1' }), item({ id: 'i2' })]),
    );
    const { result } = renderHook(() => useDeleteBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate('i1');

    await waitFor(() => {
      const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
      expect(cached?.items.map((i) => i.id)).toEqual(['i2']);
    });
    expect(deleteMock).toHaveBeenCalledWith('/retro-items/i1/');
  });

  it('restores the removed sticky when the DELETE fails', async () => {
    deleteMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<RetroBoardResponse>(
      boardKey('s1'),
      board([item({ id: 'i1' }), item({ id: 'i2' })]),
    );
    const { result } = renderHook(() => useDeleteBoardItem('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate('i1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<RetroBoardResponse>(boardKey('s1'));
    expect(cached?.items.map((i) => i.id)).toEqual(['i1', 'i2']);
  });
});

describe('useConvertStickyToAction', () => {
  it('invalidates both the board and the retro reads on success', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'action-1' } });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useConvertStickyToAction('s1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate('i1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/retro-items/i1/convert-to-action/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: boardKey('s1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint', 's1', 'retro'] });
  });
});

describe('usePulse', () => {
  it('translates a 204 (not yet answered) into a sentinel null', async () => {
    getMock.mockResolvedValueOnce({ status: 204, data: '' });
    const qc = makeQC();
    const { result } = renderHook(() => usePulse('s1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('returns the requester own response when present', async () => {
    const mine: PulseResponse = {
      id: 'p1',
      retro: 'r1',
      mood: 4,
      energy: 3,
      confidence: null,
      updated_at: '2026-06-25T00:00:00Z',
    };
    getMock.mockResolvedValueOnce({ status: 200, data: mine });
    const qc = makeQC();
    const { result } = renderHook(() => usePulse('s1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mine);
  });
});

describe('useUpsertPulse', () => {
  it('optimistically writes the new answer before the request resolves', async () => {
    putMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = makeQC();
    qc.setQueryData<PulseResponse | null>(pulseKey('s1'), null);
    const { result } = renderHook(() => useUpsertPulse('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ mood: 5, energy: 4 });

    await waitFor(() => {
      const cached = qc.getQueryData<PulseResponse | null>(pulseKey('s1'));
      expect(cached?.mood).toBe(5);
      expect(cached?.energy).toBe(4);
      expect(cached?.confidence).toBeNull();
    });
    expect(putMock).toHaveBeenCalledWith('/sprints/s1/pulse/', {
      mood: 5,
      energy: 4,
      confidence: null,
    });
  });

  it('rolls back to the prior answer when the PUT fails', async () => {
    const prior: PulseResponse = {
      id: 'p1',
      retro: 'r1',
      mood: 2,
      energy: 2,
      confidence: 1,
      updated_at: '2026-06-25T00:00:00Z',
    };
    putMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<PulseResponse | null>(pulseKey('s1'), prior);
    const { result } = renderHook(() => useUpsertPulse('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ mood: 5, energy: 4 });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<PulseResponse | null>(pulseKey('s1'))).toEqual(prior);
  });

  it('writes the server answer and refetches the privacy-gated trend on success', async () => {
    const saved: PulseResponse = {
      id: 'p1',
      retro: 'r1',
      mood: 5,
      energy: 4,
      confidence: null,
      updated_at: '2026-06-25T01:00:00Z',
    };
    putMock.mockResolvedValueOnce({ data: saved });
    const qc = makeQC();
    qc.setQueryData<PulseResponse | null>(pulseKey('s1'), null);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpsertPulse('s1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ mood: 5, energy: 4 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData<PulseResponse | null>(pulseKey('s1'))).toEqual(saved);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint', 's1', 'pulse-trend'] });
  });
});

describe('usePulseTrend', () => {
  it('passes a gated response through untouched (no numbers reach the client)', async () => {
    getMock.mockResolvedValueOnce({ data: { gated: true } });
    const qc = makeQC();
    const { result } = renderHook(() => usePulseTrend('s1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ gated: true });
  });

  it('passes the ungated aggregate through untouched', async () => {
    const ungated = {
      gated: false as const,
      points: [
        {
          sprint_id: 's1',
          sprint_name: 'Sprint 1',
          avg_mood: 4,
          avg_energy: 3,
          avg_confidence: null,
          response_count: 5,
        },
      ],
      energy_declining: false,
      my_response: { mood: 4, energy: 3, confidence: null },
    };
    getMock.mockResolvedValueOnce({ data: ungated });
    const qc = makeQC();
    const { result } = renderHook(() => usePulseTrend('s1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(ungated);
  });
});
