import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { axiosRefusal } from '@/test/axiosError';
import { useScheduleFeasibility, scheduleFeasibilityKey } from './useScheduleFeasibility';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get } }));

describe('useScheduleFeasibility 422', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces a cached loop verdict with null when the server answers 422', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(scheduleFeasibilityKey('p1'), { computable: false, cycle: [] });
    get.mockRejectedValue(axiosRefusal(422, { detail: 'x' }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useScheduleFeasibility('p1'), { wrapper });
    expect(result.current.data).toMatchObject({ computable: false });
    await qc.invalidateQueries({ queryKey: scheduleFeasibilityKey('p1') });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.isError).toBe(false);
  });
});
