/**
 * Unit tests for `useSurfaceVisibility` (ADR-0193, issue 956).
 *
 * The hook wraps `useProject` and extracts `effective_surface_visibility`,
 * falling back to the all-visible default when the project has not loaded yet
 * (null projectId, loading, or unknown project). Hide-only (ADR-0041) — a
 * false value hides chrome, never the route or data.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useSurfaceVisibility } from './useSurfaceVisibility';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Minimal ApiProjectDetail payload carrying only the fields this hook reads. */
function projectFixture(eff: Record<string, boolean>) {
  return {
    id: 'proj-1',
    server_version: 1,
    name: 'Test',
    effective_surface_visibility: eff,
  };
}

const ALL_VISIBLE = {
  reporting: true,
  time_tracking: true,
  baselines: true,
  monte_carlo: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSurfaceVisibility', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('returns all-visible default when projectId is null (hook is disabled)', () => {
    // null projectId disables useProject → data is undefined → fallback to ALL_VISIBLE
    const { result } = renderHook(
      () => useSurfaceVisibility(null),
      { wrapper: makeWrapper(qc) },
    );
    expect(result.current).toEqual(ALL_VISIBLE);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns all-visible default while the project is loading', () => {
    // Mock never resolves — hook stays in loading state
    getMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useSurfaceVisibility('proj-1'),
      { wrapper: makeWrapper(qc) },
    );
    // data is undefined during loading → fallback
    expect(result.current).toEqual(ALL_VISIBLE);
  });

  it('returns the effective_surface_visibility from the project once loaded', async () => {
    const eff = {
      reporting: false,
      time_tracking: true,
      baselines: false,
      monte_carlo: false,
    };
    getMock.mockResolvedValueOnce({ data: projectFixture(eff) });

    const { result } = renderHook(
      () => useSurfaceVisibility('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.reporting).toBe(false));

    expect(result.current).toEqual(eff);
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/');
  });

  it('returns all-visible when reporting is true in the payload', async () => {
    getMock.mockResolvedValueOnce({ data: projectFixture(ALL_VISIBLE) });

    const { result } = renderHook(
      () => useSurfaceVisibility('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.reporting).toBe(true));
    expect(result.current).toEqual(ALL_VISIBLE);
  });
});
