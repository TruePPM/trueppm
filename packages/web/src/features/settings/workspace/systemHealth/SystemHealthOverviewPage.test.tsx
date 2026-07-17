/**
 * SystemHealthOverviewPage — component unit tests.
 *
 * Exercises the status-to-chrome mapping and the four render branches over a
 * mocked useSystemHealth: first-load skeleton, hard error (no data), a healthy
 * "all-ok" snapshot, and a "degraded" snapshot (stale beat, parked dead-letter
 * tasks, a critical component). Fixtures use the REAL SystemHealthResponse shape
 * (TRUEPPM_WEBHOOK_RETENTION_DAYS retention keys, beat.stale_threshold_seconds,
 * dead_letter.by_status) — no invented keys.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { SystemHealthOverviewPage } from './SystemHealthOverviewPage';
import type { SystemHealthResponse } from '@/hooks/useSystemHealth';

const useSystemHealth = vi.fn();

vi.mock('@/hooks/useSystemHealth', async () => {
  const actual = await vi.importActual('@/hooks/useSystemHealth');
  return {
    ...actual,
    useSystemHealth: () => useSystemHealth() as unknown,
  };
});

function makeHealth(over: Partial<SystemHealthResponse> = {}): SystemHealthResponse {
  return {
    generated_at: '2026-05-25T00:00:00Z',
    components: [
      {
        key: 'outbox_dispatcher',
        label: 'Outbox dispatcher',
        status: 'ok',
        state_label: 'Running',
        meta: 'drain every 5s',
      },
      {
        key: 'celery_worker',
        label: 'Celery worker',
        status: 'ok',
        state_label: 'Online',
        meta: '2 workers',
      },
    ],
    beat: {
      last_heartbeat: '2026-05-25T00:00:00Z',
      seconds_since: 5,
      stale: false,
      stale_threshold_seconds: 120,
    },
    scheduled_tasks: [
      {
        name: 'Heartbeat',
        task: 'trueppm.beat_heartbeat',
        cadence: 'every 60s',
        category: 'heartbeat',
      },
    ],
    dead_letter: { parked: 0, oldest_age_seconds: null, top_cause: null, by_status: {} },
    retention: [
      {
        key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS',
        label: 'Webhook delivery records',
        unit: 'days',
        value: 30,
        disabled: false,
      },
    ],
    telemetry: {
      enabled: false,
      endpoint: '',
      endpoint_configured: false,
      protocol: 'grpc',
      service_name: 'trueppm-api',
      traces_enabled: true,
      metrics_enabled: true,
      sampler: 'parentbased_always_on',
      sampler_arg: '',
    },
    ...over,
  };
}

function mockResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    dataUpdatedAt: Date.now(),
    ...over,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SystemHealthOverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SystemHealthOverviewPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the first-load skeleton while isLoading', () => {
    useSystemHealth.mockReturnValue(mockResult({ isLoading: true }));
    renderPage();
    expect(screen.getByLabelText(/Loading system health/i)).toBeInTheDocument();
  });

  it('renders a hard-error state with a Retry button when there is no data', () => {
    useSystemHealth.mockReturnValue(
      mockResult({ error: new Error('boom'), data: undefined }),
    );
    renderPage();
    expect(screen.getByText(/Couldn't load system health/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('renders a role-aware message and no Retry button on 403', () => {
    const err = new AxiosError('Forbidden');
    // Minimal AxiosResponse shape — only status is read by the component.
    err.response = { status: 403 } as never;
    useSystemHealth.mockReturnValue(mockResult({ error: err, data: undefined }));
    renderPage();
    expect(screen.getByText(/Admin access required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('renders the all-ok snapshot: live beat, clean dead-letter, component cards', () => {
    useSystemHealth.mockReturnValue(mockResult({ data: makeHealth() }));
    renderPage();

    expect(screen.getByText('Outbox dispatcher')).toBeInTheDocument();
    expect(screen.getByText('Celery worker')).toBeInTheDocument();
    // Beat is live (not stale).
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    // Clean dead-letter queue.
    expect(screen.getByText(/No parked tasks/i)).toBeInTheDocument();
    // Retention row rendered from the real key.
    expect(screen.getByText('Webhook delivery records')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    // No OK status dots should carry a Critical label.
    expect(screen.queryByLabelText('Critical')).not.toBeInTheDocument();
  });

  it('renders the degraded snapshot: stale beat, parked tasks, per-status breakdown', () => {
    const degraded = makeHealth({
      components: [
        {
          key: 'celery_worker',
          label: 'Celery worker',
          status: 'crit',
          state_label: 'No workers online',
          meta: '0 workers',
        },
      ],
      beat: {
        last_heartbeat: '2026-05-25T00:00:00Z',
        seconds_since: 900,
        stale: true,
        stale_threshold_seconds: 120,
      },
      dead_letter: {
        parked: 4,
        oldest_age_seconds: 7200,
        top_cause: 'RuntimeError',
        by_status: { dead: 3, pending_retry: 1 },
      },
    });
    useSystemHealth.mockReturnValue(mockResult({ data: degraded }));
    renderPage();

    // Critical component chrome.
    expect(screen.getByText('No workers online')).toBeInTheDocument();
    expect(screen.getByLabelText('Critical')).toBeInTheDocument();
    // Stale beat.
    expect(screen.getByText('Stale')).toBeInTheDocument();
    // Parked count + top cause.
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('RuntimeError')).toBeInTheDocument();
    // Per-status breakdown string.
    expect(screen.getByText('3 dead · 1 pending_retry')).toBeInTheDocument();
    // Clean-queue message must be absent when parked > 0.
    expect(screen.queryByText(/No parked tasks/i)).not.toBeInTheDocument();
  });

  it('renders the telemetry card as Off with a not-configured hint when export is unset', () => {
    useSystemHealth.mockReturnValue(mockResult({ data: makeHealth() }));
    renderPage();
    expect(screen.getByText('Telemetry')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText(/OpenTelemetry export is not configured/i)).toBeInTheDocument();
  });

  it('renders the telemetry card as Exporting with endpoint and sampler when live', () => {
    const health = makeHealth({
      telemetry: {
        enabled: true,
        endpoint: 'otel-collector.internal:4317',
        endpoint_configured: true,
        protocol: 'grpc',
        service_name: 'trueppm-api',
        traces_enabled: true,
        metrics_enabled: false,
        sampler: 'parentbased_traceidratio',
        sampler_arg: '0.1',
      },
    });
    useSystemHealth.mockReturnValue(mockResult({ data: health }));
    renderPage();
    expect(screen.getByText('Exporting')).toBeInTheDocument();
    expect(screen.getByText('otel-collector.internal:4317')).toBeInTheDocument();
    expect(screen.getByText('parentbased_traceidratio (0.1)')).toBeInTheDocument();
    expect(screen.getByText('Traces on · Metrics off')).toBeInTheDocument();
  });

  it('renders a Disabled chip for a disabled retention entry', () => {
    const health = makeHealth({
      retention: [
        {
          key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS',
          label: 'Webhook delivery records',
          unit: 'days',
          value: null,
          disabled: true,
        },
      ],
    });
    useSystemHealth.mockReturnValue(mockResult({ data: health }));
    renderPage();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });
});
