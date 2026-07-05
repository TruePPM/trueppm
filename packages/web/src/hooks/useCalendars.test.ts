/**
 * Tests for useCalendars (#968) — the org-level working-calendar list feeding the
 * Project General override picker. Covers both response shapes the endpoint can
 * return: the default DRF pagination envelope and a bare array.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

import { useCalendars } from './useCalendars';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

const CAL_A = { id: 'cal-a', name: 'Standard 5-day', working_days: [1, 2, 3, 4, 5], hours_per_day: 8 };
const CAL_B = { id: 'cal-b', name: 'Six-day site week', working_days: [1, 2, 3, 4, 5, 6], hours_per_day: 10 };

describe('useCalendars', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('unwraps the paginated envelope into a flat calendar list', async () => {
    getMock.mockResolvedValueOnce({
      data: { count: 2, next: null, previous: null, results: [CAL_A, CAL_B] },
    });

    const { result } = renderHook(() => useCalendars(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.calendars).toHaveLength(2));
    expect(result.current.calendars.map((c) => c.id)).toEqual(['cal-a', 'cal-b']);
    expect(getMock).toHaveBeenCalledWith('/calendars/');
  });

  it('accepts a bare array response (pagination opted out)', async () => {
    getMock.mockResolvedValueOnce({ data: [CAL_A] });

    const { result } = renderHook(() => useCalendars(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.calendars).toHaveLength(1));
    expect(result.current.calendars[0].name).toBe('Standard 5-day');
  });

  it('returns an empty list while loading (never undefined)', () => {
    getMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useCalendars(), { wrapper: makeWrapper(qc) });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.calendars).toEqual([]);
  });
});
