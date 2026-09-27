import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useCreateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhookTestResult,
  useWebhooks,
  type ApiWebhook,
  type ApiWebhookDelivery,
  type IntegrationScope,
} from './useWebhooks';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

const PROJECT: IntegrationScope = { kind: 'project', id: 'p1' };
const PROGRAM: IntegrationScope = { kind: 'program', id: 'pg1' };

const HOOK: ApiWebhook = {
  id: 'wh1',
  project: 'p1',
  program: null,
  url: 'https://example.test/hook',
  events: ['task.updated'],
  format: 'json',
  is_active: true,
  secret_set: true,
  consecutive_failures: 0,
  last_failure_at: null,
  last_failure_reason: '',
  disabled_at: null,
  disabled_reason: '',
  created_at: '2026-04-01T00:00:00Z',
  created_by: null,
};

function delivery(overrides: Partial<ApiWebhookDelivery> = {}): ApiWebhookDelivery {
  return {
    id: 'd1',
    event_type: 'webhook.test',
    sequence_number: 1,
    payload: {},
    status: 'pending',
    response_status: null,
    attempt_count: 1,
    created_at: '2026-04-01T00:00:00Z',
    completed_at: null,
    ...overrides,
  };
}

function paginated<T>(results: T[]) {
  return { data: { count: results.length, next: null, previous: null, results } };
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [getMock, postMock, patchMock, deleteMock].forEach((m) => m.mockReset());
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => vi.useRealTimers());

describe('useWebhooks / useWebhookDeliveries', () => {
  it('reads the list off the scope-pluralized path and unwraps the page', async () => {
    getMock.mockResolvedValue(paginated([HOOK]));
    const { result } = renderHook(() => useWebhooks(PROGRAM), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/programs/pg1/webhooks/');
    expect(result.current.data).toEqual([HOOK]);
  });

  it('stays disabled without a scope, or a scope with no id', () => {
    const { result } = renderHook(() => useWebhooks(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    const { result: blank } = renderHook(() => useWebhooks({ kind: 'project', id: '' }), {
      wrapper,
    });
    expect(blank.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('reads the first deliveries page for one webhook, and only once both ids are known', async () => {
    getMock.mockResolvedValue(paginated([delivery()]));
    const { result: idle } = renderHook(() => useWebhookDeliveries(PROJECT, null), { wrapper });
    expect(idle.current.fetchStatus).toBe('idle');

    const { result } = renderHook(() => useWebhookDeliveries(PROJECT, 'wh1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/webhooks/wh1/deliveries/');
    expect(result.current.data).toHaveLength(1);
  });
});

describe('webhook mutations', () => {
  it('create posts the body to the scope path and invalidates the list', async () => {
    postMock.mockResolvedValue({ data: { ...HOOK, secret: 'once' } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateWebhook(PROJECT), { wrapper });
    const body = { url: HOOK.url, events: HOOK.events, format: 'json' };
    let created: ApiWebhook | undefined;
    await act(async () => {
      created = await result.current.mutateAsync(body);
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/webhooks/', body);
    expect(created?.secret).toBe('once');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['webhooks', 'project', 'p1'] });
  });

  it('update patches one webhook and invalidates the list', async () => {
    patchMock.mockResolvedValue({ data: { ...HOOK, is_active: false } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateWebhook(PROGRAM), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'wh1', body: { is_active: false } });
    });
    expect(patchMock).toHaveBeenCalledWith('/programs/pg1/webhooks/wh1/', { is_active: false });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['webhooks', 'program', 'pg1'] });
  });

  it('delete removes one webhook and invalidates the list', async () => {
    deleteMock.mockResolvedValue({});
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteWebhook(PROJECT), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('wh1');
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/webhooks/wh1/');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['webhooks', 'project', 'p1'] });
  });

  it("test posts to the ping endpoint and invalidates that webhook's deliveries", async () => {
    postMock.mockResolvedValue({ data: { delivery_id: 'd9' } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useTestWebhook(PROJECT), { wrapper });
    let ack: { delivery_id: string } | undefined;
    await act(async () => {
      ack = await result.current.mutateAsync('wh1');
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/webhooks/wh1/test/');
    expect(ack).toEqual({ delivery_id: 'd9' });
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['webhooks', 'project', 'p1', 'wh1', 'deliveries'],
    });
  });
});

describe('useWebhookTestResult', () => {
  it('does nothing without a delivery id', () => {
    const { result } = renderHook(() => useWebhookTestResult(PROJECT, 'wh1', null), { wrapper });
    expect(result.current).toEqual({ delivery: null, settled: false, timedOut: false });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('settles as soon as the delivery row leaves pending', async () => {
    getMock.mockResolvedValue(
      paginated([
        delivery({ id: 'other' }),
        delivery({ id: 'd1', status: 'failed', response_status: 500 }),
      ]),
    );
    const { result } = renderHook(() => useWebhookTestResult(PROJECT, 'wh1', 'd1'), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.delivery?.response_status).toBe(500);
    expect(result.current.timedOut).toBe(false);
    expect(getMock).toHaveBeenCalledWith('/projects/p1/webhooks/wh1/deliveries/');
  });

  it('reports null (not settled) while the row has not reached the page yet', async () => {
    getMock.mockResolvedValue(paginated([delivery({ id: 'other', status: 'success' })]));
    const { result } = renderHook(() => useWebhookTestResult(PROJECT, 'wh1', 'd1'), { wrapper });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.delivery).toBeNull());
    expect(result.current.settled).toBe(false);
  });

  it('times out once the polling budget is spent on a still-pending delivery', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    getMock.mockResolvedValue(paginated([delivery({ id: 'd1', status: 'pending' })]));
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useWebhookTestResult(PROJECT, 'wh1', id),
      { wrapper, initialProps: { id: 'd1' } },
    );
    await waitFor(() => expect(result.current.delivery?.status).toBe('pending'));
    expect(result.current.timedOut).toBe(false);

    now += 46_000;
    rerender({ id: 'd1' });
    expect(result.current.settled).toBe(false);
    expect(result.current.timedOut).toBe(true);

    // A new delivery id restarts the budget.
    rerender({ id: 'd2' });
    expect(result.current.timedOut).toBe(false);
  });
});
