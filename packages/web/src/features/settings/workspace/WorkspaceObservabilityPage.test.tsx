import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import type { SystemHealthResponse } from '@/hooks/useSystemHealth';
import { WorkspaceObservabilityPage } from './WorkspaceObservabilityPage';

// Strip the settings-shell chrome — the shell is covered by SettingsShell.test.tsx.
vi.mock('../SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsPageTitle: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  ),
  // TelemetryCard (rendered by the page) imports SettingsCard from this module.
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: { name: 'TrueScope' }, isLoading: false }),
}));

const useSystemHealth = vi.fn();
vi.mock('@/hooks/useSystemHealth', async () => {
  const actual = await vi.importActual('@/hooks/useSystemHealth');
  return { ...actual, useSystemHealth: () => useSystemHealth() as unknown };
});

const TELEMETRY_UNCONFIGURED: SystemHealthResponse['telemetry'] = {
  enabled: false,
  endpoint: '',
  endpoint_configured: false,
  protocol: 'grpc',
  service_name: 'trueppm-api',
  service_version: '0.5.0',
  edition: 'community',
  traces_enabled: true,
  metrics_enabled: true,
  sampler: 'parentbased_always_on',
  sampler_arg: '',
  live: { available: false },
};

function health(telemetry: SystemHealthResponse['telemetry']): SystemHealthResponse {
  return {
    generated_at: '2026-05-25T00:00:00Z',
    components: [],
    beat: { last_heartbeat: '2026-05-25T00:00:00Z', seconds_since: 5, stale: false, stale_threshold_seconds: 120 },
    scheduled_tasks: [],
    dead_letter: { parked: 0, oldest_age_seconds: null, top_cause: null, by_status: {} },
    retention: [],
    telemetry,
    security: { rate_limiting_enabled: true },
  };
}

function mockResult(over: Record<string, unknown> = {}) {
  return { data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn(), dataUpdatedAt: Date.now(), ...over };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspaceObservabilityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WorkspaceObservabilityPage (#2250)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('titles the page Observability', () => {
    useSystemHealth.mockReturnValue(mockResult({ data: health(TELEMETRY_UNCONFIGURED) }));
    renderPage();
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument();
  });

  it('renders a loading skeleton while the health query is loading', () => {
    useSystemHealth.mockReturnValue(mockResult({ isLoading: true }));
    renderPage();
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText('Telemetry')).not.toBeInTheDocument();
  });

  it('mounts the full telemetry setup card (guided setup when unconfigured)', () => {
    useSystemHealth.mockReturnValue(mockResult({ data: health(TELEMETRY_UNCONFIGURED) }));
    renderPage();
    // The guided-setup card that used to live on System Health now lives here.
    expect(screen.getByText('Telemetry')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('shows a Retry error state on a non-403 failure', () => {
    useSystemHealth.mockReturnValue(mockResult({ error: new Error('boom') }));
    renderPage();
    expect(screen.getByText(/Couldn't load telemetry status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a permission message (no Retry) on a 403', () => {
    const err = new AxiosError('forbidden');
    err.response = { status: 403 } as AxiosError['response'];
    useSystemHealth.mockReturnValue(mockResult({ error: err }));
    renderPage();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
