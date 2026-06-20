/**
 * Tests for useRecordProjectVisit (issue 1182, ADR-0150) — the fire-and-forget
 * last-visited ping. Covers the happy path (one POST per project), the inert
 * cases (no projectId), the StrictMode double-mount guard, the re-fire on
 * project change, and that a failed ping is swallowed (never rethrown).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

import { useRecordProjectVisit } from './useRecordProjectVisit';

describe('useRecordProjectVisit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: { recorded: true } });
  });

  it('posts a visit ping once for the active project', async () => {
    renderHook(() => useRecordProjectVisit('p1'));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/visit/', {});
  });

  it('does not ping when there is no projectId', () => {
    renderHook(() => useRecordProjectVisit(null));
    renderHook(() => useRecordProjectVisit(undefined));

    expect(postMock).not.toHaveBeenCalled();
  });

  it('pings only once across a re-render with the same projectId', async () => {
    const { rerender } = renderHook((id: string) => useRecordProjectVisit(id), {
      initialProps: 'p1',
    });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    rerender('p1');
    rerender('p1');

    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('pings again when the user navigates to a different project', async () => {
    const { rerender } = renderHook((id: string) => useRecordProjectVisit(id), {
      initialProps: 'p1',
    });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    rerender('p2');

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock).toHaveBeenLastCalledWith('/projects/p2/visit/', {});
  });

  it('swallows a failed ping without throwing', async () => {
    postMock.mockRejectedValueOnce(new Error('network down'));

    expect(() => renderHook(() => useRecordProjectVisit('p1'))).not.toThrow();
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
  });
});
