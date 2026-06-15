/**
 * Tests for useCurrentUserRole — the hook that gates all role-conditional UI.
 * A wrong role here silently shows or hides privileged controls, so the
 * loading/empty/error branches each need explicit coverage (#784).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useCurrentUserRole } from './useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe('useCurrentUserRole', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('hides role-gated UI pessimistically while loading (role null, isLoading true)', () => {
    getMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useCurrentUserRole('proj-1'), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(result.current.role).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it('does not fetch and reports loading when projectId is undefined', () => {
    const { result } = renderHook(() => useCurrentUserRole(undefined), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.role).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it('reads the role ordinal from the first self-membership row', async () => {
    getMock.mockResolvedValue({ data: [{ id: 'm1', role: ROLE_ADMIN }] });
    const { result } = renderHook(() => useCurrentUserRole('proj-1'), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.role).toBe(ROLE_ADMIN);
    // Queries the self-scoped membership endpoint.
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/members/', {
      params: { self: 'true' },
    });
  });

  it('returns role null (not a crash) when the membership list is empty', async () => {
    getMock.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useCurrentUserRole('proj-1'), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.role).toBeNull();
  });

  it('returns role null when the request errors (fail-closed, no retry)', async () => {
    getMock.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useCurrentUserRole('proj-1'), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.role).toBeNull();
  });
});
