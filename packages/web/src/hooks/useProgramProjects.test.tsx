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
