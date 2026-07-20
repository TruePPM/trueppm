/**
 * Tests for useScopeChangeActions (ADR-0102 §5) — verifies the four endpoint
 * shapes (single + bulk accept/reject) and the bulk omit-ids = act-on-all body.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useScopeChangeActions, useScopeDecisionFeedback } from './useScopeChangeActions';

const { postMock, toastMock, updateTaskMutate } = vi.hoisted(() => ({
  postMock: vi.fn().mockResolvedValue({ data: { pending_count: 0 } }),
  toastMock: { error: vi.fn(), success: vi.fn(), action: vi.fn() },
  updateTaskMutate: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));

vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ lower: 'sprint', plural: 'sprints', singular: 'Sprint' }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: updateTaskMutate }),
}));

function makeErrorQC() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useScopeChangeActions', () => {
  beforeEach(() => {
    postMock.mockClear();
    toastMock.error.mockClear();
    toastMock.success.mockClear();
    toastMock.action.mockClear();
    updateTaskMutate.mockClear();
  });

  it('single accept POSTs the scope-change accept endpoint', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.acceptOne.mutate('sc-9');
    await waitFor(() => expect(result.current.acceptOne.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/scope-changes/sc-9/accept/');
  });

  it('single reject POSTs the scope-change reject endpoint', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.rejectOne.mutate('sc-9');
    await waitFor(() => expect(result.current.rejectOne.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/scope-changes/sc-9/reject/');
  });

  it('bulk accept with no ids sends an empty body = act on ALL pending', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.acceptBulk.mutate(undefined);
    await waitFor(() => expect(result.current.acceptBulk.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/s1/scope-changes/accept/', {});
  });

  it('bulk reject with explicit ids forwards the ids list', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.rejectBulk.mutate(['a', 'b']);
    await waitFor(() => expect(result.current.rejectBulk.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/sprints/s1/scope-changes/reject/', {
      ids: ['a', 'b'],
    });
  });
});

describe('useScopeChangeActions — failure feedback (#2149)', () => {
  beforeEach(() => {
    postMock.mockReset();
    toastMock.error.mockClear();
  });

  const cases: Array<[string, (r: ReturnType<typeof useScopeChangeActions>) => void, string]> = [
    ['acceptOne', (r) => r.acceptOne.mutate('sc-1'), "Couldn't accept the scope change — try again."],
    ['rejectOne', (r) => r.rejectOne.mutate('sc-1'), "Couldn't reject the scope change — try again."],
    ['acceptBulk', (r) => r.acceptBulk.mutate(undefined), "Couldn't accept the pending items — try again."],
    ['rejectBulk', (r) => r.rejectBulk.mutate(undefined), "Couldn't reject the pending items — try again."],
  ];

  it.each(cases)('%s toasts the failure (incl. the authoritative 403)', async (
    _name,
    fire,
    message,
  ) => {
    postMock.mockRejectedValue({ response: { status: 403 } });
    const qc = makeErrorQC();
    const { result } = renderHook(() => useScopeChangeActions('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    fire(result.current);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(message));
  });
});

describe('useScopeDecisionFeedback — success/undo contract (#2149)', () => {
  beforeEach(() => {
    toastMock.success.mockClear();
    toastMock.action.mockClear();
    updateTaskMutate.mockClear();
  });

  it('confirmAccepted fires a success toast naming the task and the iteration label', () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeDecisionFeedback('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.confirmAccepted('Login flow');
    expect(toastMock.success).toHaveBeenCalledWith('Login flow accepted into the sprint.');
  });

  it('confirmRejectedWithUndo offers an Undo that re-assigns the task to the sprint', () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeDecisionFeedback('p1', 's1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.confirmRejectedWithUndo('t9', 'Login flow');

    expect(toastMock.action).toHaveBeenCalledTimes(1);
    const [message, action, opts] = toastMock.action.mock.calls[0] as [
      string,
      { label: string; onClick: () => void },
      { variant: string },
    ];
    expect(message).toBe('Login flow removed from the sprint.');
    expect(action.label).toBe('Undo');
    expect(opts).toEqual({ variant: 'info' });

    // Invoking the Undo re-adds the task via a plain sprint re-assign.
    action.onClick();
    expect(updateTaskMutate).toHaveBeenCalledWith({ id: 't9', projectId: 'p1', sprint: 's1' });
  });

  it('falls back to a plain confirmation (no Undo) when the sprint id is unknown', () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useScopeDecisionFeedback('p1', null), {
      wrapper: makeWrapper(qc),
    });
    result.current.confirmRejectedWithUndo('t9', 'Login flow');
    expect(toastMock.success).toHaveBeenCalledWith('Login flow removed from the sprint.');
    expect(toastMock.action).not.toHaveBeenCalled();
  });
});
