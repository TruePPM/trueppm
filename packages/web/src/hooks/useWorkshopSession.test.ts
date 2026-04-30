/**
 * Unit tests for the workshop session hooks.
 *
 * Validates query key setup, 404 normalisation, and mutation side-effects
 * (cache update after start/end).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useWorkshopSession, useStartWorkshop, useEndWorkshop } from './useWorkshopSession';
import { apiClient } from '@/api/client';
import type { WorkshopSession } from '@/types';

vi.mock('@/api/client');

const mockSession: WorkshopSession = {
  id: 'session-uuid',
  project_id: 'project-uuid',
  started_by_id: 'user-uuid',
  started_at: '2026-04-29T10:00:00Z',
  ended_at: null,
  participants: [],
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe('useWorkshopSession', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('returns the active session from the API', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: mockSession } as never);
    const { result } = renderHook(() => useWorkshopSession('project-uuid'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockSession);
  });

  it('returns null when API returns 404', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce({ response: { status: 404 } });
    const { result } = renderHook(() => useWorkshopSession('project-uuid'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('is disabled when projectId is null', () => {
    const { result } = renderHook(() => useWorkshopSession(null), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useStartWorkshop', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('updates cache with returned session on success', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: mockSession } as never);
    const { result } = renderHook(() => useStartWorkshop('project-uuid'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['workshopSession', 'project-uuid'])).toEqual(mockSession);
  });
});

describe('useEndWorkshop', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('clears session from cache on success', async () => {
    qc.setQueryData(['workshopSession', 'project-uuid'], mockSession);
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: { ...mockSession, ended_at: '2026-04-29T11:00:00Z' } } as never);
    const { result } = renderHook(() => useEndWorkshop('project-uuid'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['workshopSession', 'project-uuid'])).toBeNull();
  });
});
