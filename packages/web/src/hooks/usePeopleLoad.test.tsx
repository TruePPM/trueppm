import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { PEOPLE_LOAD_WEEKS, usePeopleLoad } from './usePeopleLoad';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

describe('usePeopleLoad', () => {
  beforeEach(() => getMock.mockReset());

  it('reads /me/people-load/ with the default week range', async () => {
    getMock.mockResolvedValue({ data: { people: [] } });
    const { result } = renderHook(() => usePeopleLoad(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/me/people-load/', {
      params: { weeks: PEOPLE_LOAD_WEEKS },
    });
    expect(result.current.data).toEqual({ people: [] });
  });

  it('passes a custom week range through', async () => {
    getMock.mockResolvedValue({ data: { people: [] } });
    const { result } = renderHook(() => usePeopleLoad(4), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/me/people-load/', { params: { weeks: 4 } });
  });

  it('narrows the read to one program with ?program=', async () => {
    getMock.mockResolvedValue({ data: { people: [] } });
    const { result } = renderHook(() => usePeopleLoad(8, 'prog-1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/me/people-load/', {
      params: { weeks: 8, program: 'prog-1' },
    });
  });

  it('surfaces a request failure as an error state', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => usePeopleLoad(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
