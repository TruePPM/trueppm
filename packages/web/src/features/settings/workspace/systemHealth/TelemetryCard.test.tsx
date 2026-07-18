/**
 * TelemetryCard — component unit tests (#2110).
 *
 * Covers the three base states derived from config (unconfigured guided-setup,
 * exporting, export-off) and the Test-export interaction (idle → click → the three
 * outcomes) over a mocked useTelemetryTestExport. The mutation hook is mocked so
 * the tests never hit the network; card state is driven by the telemetry fixture
 * plus the mocked mutation result — matching the component's honest-state model.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelemetryCard } from './TelemetryCard';
import type { SystemHealthTelemetry, TelemetryTestResult } from '@/hooks/useSystemHealth';

interface MockMutation {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  data?: TelemetryTestResult;
}

let testExport: MockMutation;

vi.mock('@/hooks/useSystemHealth', async () => {
  const actual = await vi.importActual('@/hooks/useSystemHealth');
  return {
    ...actual,
    useTelemetryTestExport: () => testExport,
  };
});

function makeTelemetry(over: Partial<SystemHealthTelemetry> = {}): SystemHealthTelemetry {
  return {
    enabled: true,
    endpoint: 'otel-collector.internal:4317',
    endpoint_configured: true,
    protocol: 'grpc',
    service_name: 'trueppm-api',
    service_version: '0.5.0',
    edition: 'community',
    traces_enabled: true,
    metrics_enabled: true,
    sampler: 'parentbased_traceidratio',
    sampler_arg: '0.1',
    ...over,
  };
}

function makeResult(over: Partial<TelemetryTestResult> = {}): TelemetryTestResult {
  return {
    mode: 'export',
    outcome: 'success',
    endpoint: 'otel-collector.internal:4317',
    protocol: 'grpc',
    duration_ms: 84,
    detail: 'Canary span accepted by the collector — the export path is working end to end.',
    checked_at: '2026-07-17T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  testExport = { mutate: vi.fn(), isPending: false, isError: false };
});

describe('TelemetryCard — states', () => {
  it('shows guided setup with copy-paste snippets when unconfigured', () => {
    render(<TelemetryCard telemetry={makeTelemetry({ enabled: false, endpoint: '', endpoint_configured: false })} />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/Export is off — no collector endpoint set/i)).toBeInTheDocument();
    // Guided-setup backend picker + config snippet are present.
    expect(screen.getByRole('button', { name: 'Grafana Tempo' })).toBeInTheDocument();
    expect(screen.getByText(/OTEL_EXPORTER_OTLP_ENDPOINT=/)).toBeInTheDocument();
    // No test-export button in the unconfigured state.
    expect(screen.queryByRole('button', { name: /Test export/i })).not.toBeInTheDocument();
  });

  it('switches the snippet to Helm values when the Helm segment is clicked', () => {
    render(<TelemetryCard telemetry={makeTelemetry({ enabled: false, endpoint: '', endpoint_configured: false })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Helm values' }));
    expect(screen.getByText(/helm upgrade trueppm/)).toBeInTheDocument();
    expect(screen.getByText(/secretRef:/)).toBeInTheDocument();
  });

  it('shows the exporting state with config, signals, and a test-export button', () => {
    render(<TelemetryCard telemetry={makeTelemetry({ metrics_enabled: false })} />);
    expect(screen.getByText('Exporting')).toBeInTheDocument();
    expect(screen.getByText('otel-collector.internal:4317')).toBeInTheDocument();
    expect(screen.getByText('parentbased_traceidratio · 0.1')).toBeInTheDocument();
    expect(screen.getByText('Traces')).toBeInTheDocument();
    expect(screen.getByText('Metrics')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test export/i })).toBeInTheDocument();
    // The bearer token is never rendered — only the redacted placeholder.
    expect(screen.getByText('hidden — never displayed')).toBeInTheDocument();
  });

  it('shows the switched-off banner when an endpoint is set but export is disabled', () => {
    render(<TelemetryCard telemetry={makeTelemetry({ enabled: false })} />);
    expect(screen.getByText('Export off')).toBeInTheDocument();
    expect(screen.getByText(/Export switched off — this is a config choice/i)).toBeInTheDocument();
    // Test export still available (probes reachability).
    expect(screen.getByRole('button', { name: /Test export/i })).toBeInTheDocument();
  });
});

describe('TelemetryCard — test export', () => {
  it('calls the mutation when Test export is clicked', () => {
    render(<TelemetryCard telemetry={makeTelemetry()} />);
    fireEvent.click(screen.getByRole('button', { name: /Test export/i }));
    expect(testExport.mutate).toHaveBeenCalledTimes(1);
  });

  it('shows the sending state while pending', () => {
    testExport = { mutate: vi.fn(), isPending: true, isError: false };
    render(<TelemetryCard telemetry={makeTelemetry()} />);
    const btn = screen.getByRole('button', { name: /Sending canary span/i });
    expect(btn).toBeDisabled();
  });

  it('renders a success result', () => {
    testExport = { mutate: vi.fn(), isPending: false, isError: false, data: makeResult() };
    render(<TelemetryCard telemetry={makeTelemetry()} />);
    expect(screen.getByText('Collector accepted the canary span')).toBeInTheDocument();
    expect(screen.getByText(/working end to end/i)).toBeInTheDocument();
    expect(screen.getByText('· 84 ms')).toBeInTheDocument();
  });

  it('renders a reachable-only result (export off)', () => {
    testExport = {
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: makeResult({ mode: 'probe', outcome: 'reachable', detail: 'Collector endpoint is reachable.' }),
    };
    render(<TelemetryCard telemetry={makeTelemetry({ enabled: false })} />);
    expect(screen.getByText('Collector reachable — no span sent')).toBeInTheDocument();
  });

  it('renders a failure result', () => {
    testExport = {
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: makeResult({ outcome: 'failure', detail: 'Connection refused — nothing is listening.' }),
    };
    render(<TelemetryCard telemetry={makeTelemetry()} />);
    expect(screen.getByText('Export could not reach the collector')).toBeInTheDocument();
    expect(screen.getByText(/Connection refused/i)).toBeInTheDocument();
  });

  it('shows a request-failed message when the mutation itself errors', () => {
    testExport = { mutate: vi.fn(), isPending: false, isError: true };
    render(<TelemetryCard telemetry={makeTelemetry()} />);
    expect(screen.getByText('Could not run the test')).toBeInTheDocument();
  });
});
