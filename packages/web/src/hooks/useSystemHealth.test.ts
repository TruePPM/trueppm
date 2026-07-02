/**
 * Unit tests for useSystemHealth — verifies query-key factory and API path.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useSystemHealth, systemHealthKeys } from './useSystemHealth';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const sampleResponse = {
  generated_at: '2026-05-25T00:00:00Z',
  components: [
    { key: 'outbox_dispatcher', label: 'Outbox dispatcher', status: 'ok', state_label: 'Running', meta: 'drain every 5s' },
  ],
  beat: {
    last_heartbeat: '2026-05-25T00:00:00Z',
    seconds_since: 5,
    stale: false,
    stale_threshold_seconds: 120,
  },
  scheduled_tasks: [
    { name: 'Heartbeat', task: 'trueppm.beat_heartbeat', cadence: 'every 60s', category: 'heartbeat' },
  ],
  dead_letter: { parked: 0, oldest_age_seconds: null, top_cause: null, by_status: {} },
  retention: [
    { key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS', label: 'Webhook delivery records', unit: 'days', value: 30, disabled: false },
  ],
};

describe('systemHealthKeys', () => {
  it('has a stable "all" key', () => {
    expect(systemHealthKeys.all).toEqual(['system-health']);
  });

  it('detail() includes the all key as a prefix', () => {
    const detail = systemHealthKeys.detail();
    expect(detail[0]).toBe('system-health');
    expect(detail).toHaveLength(2);
  });
});

describe('useSystemHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls GET /health/system/ and returns the response', async () => {
    getMock.mockResolvedValue({ data: sampleResponse });
    const qc = newQc();
    const { result } = renderHook(() => useSystemHealth(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getMock).toHaveBeenCalledWith('/health/system/');
    expect(result.current.data?.dead_letter.parked).toBe(0);
    expect(result.current.data?.components).toHaveLength(1);
  });

  it('surfaces an error when the API call fails', async () => {
    getMock.mockRejectedValue(new Error('Network error'));
    const qc = newQc();
    const { result } = renderHook(() => useSystemHealth(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeUndefined();
  });
});
