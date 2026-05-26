/**
 * Unit tests for the retention hooks — query-key factory and API call shapes
 * for the GET/PATCH/impact/runs endpoints (ADR-0090).
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useRetentionSettings,
  useUpdateRetention,
  useRetentionImpact,
  useRunPurge,
  retentionKeys,
  type RetentionState,
} from './useRetention';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, patch: patchMock, post: postMock },
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

const sampleState: RetentionState = {
  policies: [
    {
      key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS',
      label: 'Webhook deliveries',
      note: 'note',
      unit: 'days',
      value: 7,
      enabled: true,
      row_count: 100,
      bytes: 2048,
    },
  ],
  schedule: { frequency: 'daily', time_of_day_utc: '02:00:00', day_of_week: null, on_failure: 'continue' },
  runs: [],
};

describe('retentionKeys', () => {
  it('has a stable "all" key', () => {
    expect(retentionKeys.all).toEqual(['retention']);
  });

  it('state() namespaces under retention', () => {
    expect(retentionKeys.state()).toEqual(['retention', 'state']);
  });

  it('impact() embeds key + value', () => {
    expect(retentionKeys.impact('HISTORY_RETENTION_DAYS', 30)).toEqual([
      'retention',
      'impact',
      'HISTORY_RETENTION_DAYS',
      30,
    ]);
  });
});

describe('useRetentionSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs /health/retention/', async () => {
    getMock.mockResolvedValue({ data: sampleState });
    const { result } = renderHook(() => useRetentionSettings(), { wrapper: makeWrapper(newQc()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/health/retention/');
    expect(result.current.data?.policies).toHaveLength(1);
  });

  it('surfaces an error on failure', async () => {
    getMock.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useRetentionSettings(), { wrapper: makeWrapper(newQc()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeTruthy();
  });
});

describe('useUpdateRetention', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PATCHes /health/retention/ with the payload', async () => {
    patchMock.mockResolvedValue({ data: sampleState });
    const { result } = renderHook(() => useUpdateRetention(), { wrapper: makeWrapper(newQc()) });
    const payload = {
      policies: [{ key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS', value: 3, enabled: true }],
      schedule: sampleState.schedule,
    };
    await result.current.mutateAsync(payload);
    expect(patchMock).toHaveBeenCalledWith('/health/retention/', payload);
  });
});

describe('useRetentionImpact', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fetch when disabled', () => {
    getMock.mockResolvedValue({ data: { eligible_rows: 0, eligible_bytes: 0 } });
    renderHook(() => useRetentionImpact('TRUEPPM_WEBHOOK_RETENTION_DAYS', 3, false), {
      wrapper: makeWrapper(newQc()),
    });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('GETs /health/retention/impact/ with key + value when enabled', async () => {
    getMock.mockResolvedValue({ data: { eligible_rows: 42, eligible_bytes: 1024 } });
    const { result } = renderHook(
      () => useRetentionImpact('TRUEPPM_WEBHOOK_RETENTION_DAYS', 3, true),
      { wrapper: makeWrapper(newQc()) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/health/retention/impact/', {
      params: { key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS', value: 3 },
    });
    expect(result.current.data?.eligible_rows).toBe(42);
  });
});

describe('useRunPurge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs /health/retention/runs/ with dry_run flag', async () => {
    postMock.mockResolvedValue({ data: { queued: true, run_id: 'run-1' } });
    const { result } = renderHook(() => useRunPurge(), { wrapper: makeWrapper(newQc()) });

    await result.current.mutateAsync(true);
    expect(postMock).toHaveBeenCalledWith('/health/retention/runs/', { dry_run: true });

    await result.current.mutateAsync(false);
    expect(postMock).toHaveBeenCalledWith('/health/retention/runs/', { dry_run: false });
  });
});
