/**
 * ADR-1485 D1: a commitment slip on `useUpdateTask` is not a refusal. A deferred
 * slip (409) and a reason-required slip (400) must NOT register the ADR-0784
 * rejection strip, whose Retry would file a second PENDING scope change.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateTask } from './useTaskMutations';

const { patchMock, rejectMock, toastInfo, requestSlipReasonMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  rejectMock: vi.fn(),
  toastInfo: vi.fn(),
  requestSlipReasonMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));
vi.mock('@/components/Toast', () => ({
  toast: { info: toastInfo, error: vi.fn(), success: vi.fn(), action: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/stores/slipReasonPromptStore', () => ({ requestSlipReason: requestSlipReasonMock }));
vi.mock('@/features/schedule/reconcile/fromMutation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, rejectSchedulePreview: rejectMock };
});

function axiosError(status: number, data: unknown): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('fail', 'ERR', { headers }, null, {
    status,
    statusText: '',
    headers: {},
    config: { headers },
    data,
  });
}

function render() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useUpdateTask(), { wrapper });
}

describe('useUpdateTask commitment slip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a deferred slip (409) toasts and registers no rejection strip', async () => {
    patchMock.mockRejectedValueOnce(
      axiosError(409, {
        code: 'commitment_slip_requires_acceptance',
        detail: 'x',
        sprint_name: 'Sprint 4',
        scope_change_id: 'sc1',
      }),
    );
    const { result } = render();
    result.current.mutate({ id: 't1', projectId: 'p1', duration: 15 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastInfo).toHaveBeenCalledWith('Waiting for a Sprint 4 decision');
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it('a reason-required slip (400) prompts and registers no rejection strip', async () => {
    patchMock.mockRejectedValueOnce(axiosError(400, { slip_reason: ['Needs a reason.'] }));
    const { result } = render();
    result.current.mutate({ id: 't1', projectId: 'p1', duration: 15 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(requestSlipReasonMock).toHaveBeenCalled();
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it('an ordinary refusal still registers the strip', async () => {
    patchMock.mockRejectedValueOnce(axiosError(400, { duration: ['Bad.'] }));
    const { result } = render();
    result.current.mutate({ id: 't1', projectId: 'p1', duration: 15 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rejectMock).toHaveBeenCalled();
  });
});
