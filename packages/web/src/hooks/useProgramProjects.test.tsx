/**
 * The wire → domain mapping for the Program → Projects tab (#2553).
 *
 * The bug this covers is a *dropped* field, which is the failure mode a mapping
 * layer hides best: `isPinned` was simply absent from the mapped object, the
 * page read `p.isPinned ?? false`, and every pinned project rendered as
 * unpinned — with no error anywhere to notice.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useProgramProjects } from './useProgramProjects';

const getMock = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: { get: (...a: unknown[]) => getMock(...a) as Promise<unknown> },
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** A minimally-populated wire row; each test overrides only what it asserts on. */
function wireRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Migration Tooling',
    description: '',
    start_date: '2026-01-01',
    methodology: 'WATERFALL',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProgramProjects', () => {
  it('maps is_pinned onto isPinned', async () => {
    getMock.mockResolvedValue({ data: [wireRow({ is_pinned: true })] });

    const { result } = renderHook(() => useProgramProjects('g1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.isPinned).toBe(true);
  });

  it('reports an unpinned row as false, not undefined', async () => {
    getMock.mockResolvedValue({ data: [wireRow({ is_pinned: false })] });

    const { result } = renderHook(() => useProgramProjects('g1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.isPinned).toBe(false);
  });

  it('defaults to false when the server omits the field entirely', async () => {
    // An older server, or any response that predates the annotation, must read
    // as "not pinned" rather than leaving the toggle's `pinned` prop undefined.
    getMock.mockResolvedValue({ data: [wireRow()] });

    const { result } = renderHook(() => useProgramProjects('g1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.isPinned).toBe(false);
  });
});

/**
 * `my_role` is the field that says whether a roster row can be opened at all
 * (#3469). Same dropped-field failure mode as `is_pinned` above: the server has
 * annotated it since #3357 and the mapper simply never carried it across, so the
 * Projects tab linked every row and a program Owner dead-ended on the ones they
 * hold no `ProjectMembership` on.
 */
describe('useProgramProjects — my_role', () => {
  it('maps a role ordinal onto myRole', async () => {
    getMock.mockResolvedValue({ data: [wireRow({ my_role: 400 })] });

    const { result } = renderHook(() => useProgramProjects('g1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.myRole).toBe(400);
  });

  it('carries an explicit null through as null — "no membership", not "unknown"', async () => {
    getMock.mockResolvedValue({ data: [wireRow({ my_role: null })] });

    const { result } = renderHook(() => useProgramProjects('g1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.myRole).toBeNull();
  });

  it('leaves myRole undefined when the key is absent entirely', async () => {
    // The two states must not collapse: an older cached response has no opinion,
    // and marking its rows "No access" would be a confident wrong answer.
    getMock.mockResolvedValue({ data: [wireRow()] });

    const { result } = renderHook(() => useProgramProjects('g1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.myRole).toBeUndefined();
    expect('myRole' in (result.current.data?.[0] ?? {})).toBe(true);
  });
});
