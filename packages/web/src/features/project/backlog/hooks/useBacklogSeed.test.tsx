import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { BACKLOG_SEED_TIMEOUT_MS, resolveBacklogSeeding, useBacklogSeed } from './useBacklogSeed';

const h = vi.hoisted(() => ({
  /** `undefined` = the first poll has not resolved yet. */
  status: 'running' as string | undefined,
  /** Every id the hook asked the application hook for, in order. */
  polled: [] as Array<string | null>,
}));

vi.mock('@/hooks/useProjectTemplates', () => ({
  useTemplateApplication: (applicationId: string | null) => {
    h.polled.push(applicationId);
    return {
      data: applicationId ? { id: applicationId, status: h.status } : undefined,
      isPending: applicationId !== null && h.status === undefined,
    };
  },
}));

function renderSeed(url: string, projectId: string | undefined = 'proj-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  // The location probe is what makes the one-shot URL strip observable.
  const result = renderHook(
    () => ({ seed: useBacklogSeed(projectId), search: useLocation().search }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
        </QueryClientProvider>
      ),
    },
  );
  return { ...result, invalidate };
}

describe('resolveBacklogSeeding (#3422)', () => {
  const base = {
    applicationId: 'app-1',
    status: 'running',
    applicationLoading: false,
    timedOut: false,
  };

  it('is seeding while the apply is pending or running and the backlog is empty', () => {
    expect(resolveBacklogSeeding({ ...base, status: 'pending' }, 0)).toBe(true);
    expect(resolveBacklogSeeding({ ...base, status: 'running' }, 0)).toBe(true);
  });

  it('is seeding before the first poll resolves, so the empty CTA never paints once', () => {
    expect(resolveBacklogSeeding({ ...base, status: undefined, applicationLoading: true }, 0)).toBe(
      true,
    );
  });

  it('is NOT seeding with no application, once timed out, or once any story exists', () => {
    expect(resolveBacklogSeeding({ ...base, applicationId: null }, 0)).toBe(false);
    expect(resolveBacklogSeeding({ ...base, timedOut: true }, 0)).toBe(false);
    expect(resolveBacklogSeeding(base, 1)).toBe(false);
  });

  it('treats every terminal status as not seeding — failed included (rule 381(a))', () => {
    // A failed apply is a total rollback, so the backlog really is empty and the
    // ordinary empty state is correct for it; the failure banner speaks ABOVE it.
    for (const status of ['success', 'failed', 'undone']) {
      expect(resolveBacklogSeeding({ ...base, status }, 0)).toBe(false);
    }
  });

  it('falls through to not-seeding on an unmapped future status', () => {
    expect(resolveBacklogSeeding({ ...base, status: 'paused' }, 0)).toBe(false);
  });
});

describe('useBacklogSeed (#3422)', () => {
  beforeEach(() => {
    h.status = 'running';
    h.polled = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('consumes ?templateApplication= into state and strips it from the URL one-shot', () => {
    const { result } = renderSeed('/?templateApplication=app-1&view=ranked');
    expect(result.current.seed.applicationId).toBe('app-1');
    // Rule 374(b): the id is gone from the URL, so a reload cannot reopen a banner
    // for an apply the user already dealt with — and sibling params survive.
    expect(result.current.search).toBe('?view=ranked');
    expect(h.polled).toContain('app-1');
  });

  it('holds no application and polls nothing without the param', () => {
    const { result } = renderSeed('/');
    expect(result.current.seed.applicationId).toBeNull();
    expect(h.polled.every((id) => id === null)).toBe(true);
  });

  it('ignores the retired ?seeding=1 flag', () => {
    const { result } = renderSeed('/?seeding=1');
    expect(result.current.seed.applicationId).toBeNull();
    expect(result.current.search).toBe('?seeding=1');
  });

  it('times out after the bounded exit, and only then', () => {
    const { result } = renderSeed('/?templateApplication=app-1');
    expect(result.current.seed.timedOut).toBe(false);
    act(() => {
      vi.advanceTimersByTime(BACKLOG_SEED_TIMEOUT_MS - 1);
    });
    expect(result.current.seed.timedOut).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.seed.timedOut).toBe(true);
  });

  it('invalidates the backlog query exactly once when the apply reports success', () => {
    h.status = 'success';
    const { result, invalidate, rerender } = renderSeed('/?templateApplication=app-1');
    expect(result.current.seed.status).toBe('success');
    const backlogCalls = () =>
      invalidate.mock.calls.filter(
        (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(['product-backlog', 'proj-1']),
      ).length;
    expect(backlogCalls()).toBe(1);
    rerender();
    rerender();
    expect(backlogCalls()).toBe(1);
  });

  it('does not invalidate on a non-terminal or failed status', () => {
    for (const status of ['running', 'failed']) {
      h.status = status;
      const { invalidate } = renderSeed('/?templateApplication=app-1');
      expect(invalidate).not.toHaveBeenCalled();
    }
  });

  it('a retry swaps to the new application and releases every latch (rule 381(d))', () => {
    h.status = 'failed';
    const { result, invalidate } = renderSeed('/?templateApplication=app-1');
    act(() => {
      result.current.seed.dismissFailure();
    });
    act(() => {
      vi.advanceTimersByTime(BACKLOG_SEED_TIMEOUT_MS);
    });
    expect(result.current.seed.failureDismissed).toBe(true);
    expect(result.current.seed.timedOut).toBe(true);

    h.status = 'running';
    act(() => {
      result.current.seed.handleRetried('app-2');
    });
    expect(result.current.seed.applicationId).toBe('app-2');
    expect(result.current.seed.failureDismissed).toBe(false);
    // Sticky state whose effect only restarts a timer — it must be RESET, or past
    // the first timeout the retry would never show the skeleton at all.
    expect(result.current.seed.timedOut).toBe(false);
    expect(h.polled).toContain('app-2');

    // The success latch is released too: the retried apply invalidates on success.
    h.status = 'success';
    act(() => {
      result.current.seed.handleRetried('app-3');
    });
    expect(
      invalidate.mock.calls.some(
        (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(['product-backlog', 'proj-1']),
      ),
    ).toBe(true);
  });

  it('dismissing the failure is its own flag and never nulls the application handle', () => {
    // Rule 381(f): the banner is the only reader of `error_detail` and the id was
    // stripped on consume, so `setApplicationId(null)` would be unrecoverable.
    h.status = 'failed';
    const { result } = renderSeed('/?templateApplication=app-1');
    act(() => {
      result.current.seed.dismissFailure();
    });
    expect(result.current.seed.failureDismissed).toBe(true);
    expect(result.current.seed.applicationId).toBe('app-1');
  });
});
