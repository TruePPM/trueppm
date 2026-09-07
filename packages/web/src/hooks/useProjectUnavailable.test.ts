import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The single input: whatever `useProject` put on `error`. Shaped as an axios
// rejection because `useProjectUnavailable` narrows with `axios.isAxiosError`,
// which tests the `isAxiosError` marker rather than the prototype.
const projectError = vi.hoisted<{ current: unknown }>(() => ({ current: null }));
vi.mock('./useProject', () => ({
  useProject: () => ({ data: undefined, isLoading: false, error: projectError.current }),
}));

import { useProjectUnavailable } from './useProjectUnavailable';

function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

describe('useProjectUnavailable (#3469)', () => {
  beforeEach(() => {
    projectError.current = null;
  });

  it.each([404, 403])('is true on %i — deleted, stale link, or no membership', (status) => {
    projectError.current = axiosError(status);
    const { result } = renderHook(() => useProjectUnavailable('p1'));
    expect(result.current).toBe(true);
  });

  it('is false when the query succeeded', () => {
    const { result } = renderHook(() => useProjectUnavailable('p1'));
    expect(result.current).toBe(false);
  });

  it.each([500, 502, 429])(
    'is false on %i — a transient server fault is not "not yours"',
    (status) => {
      // The route keeps rendering the project on a 5xx, so the chrome must too.
      // Treating every error as unavailable would blank the whole shell on a blip.
      projectError.current = axiosError(status);
      const { result } = renderHook(() => useProjectUnavailable('p1'));
      expect(result.current).toBe(false);
    },
  );

  it('is false for a non-axios error', () => {
    projectError.current = new Error('boom');
    const { result } = renderHook(() => useProjectUnavailable('p1'));
    expect(result.current).toBe(false);
  });

  it.each([null, undefined, ''])('is false off a project route (%s)', (id) => {
    // A stale error from the previously-viewed project must not follow the user
    // onto My Work; with no project in the route there is nothing to be missing.
    projectError.current = axiosError(404);
    const { result } = renderHook(() => useProjectUnavailable(id));
    expect(result.current).toBe(false);
  });
});
