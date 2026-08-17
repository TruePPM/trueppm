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
import type {
  SystemHealthTelemetry,
  SystemHealthTelemetryLive,
  TelemetrySignalHealth,
  TelemetryTestResult,
} from '@/hooks/useSystemHealth';

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
    // Default to store-unavailable so the shared fixture never injects a second
    // "Exporting" label (the healthy signal label) that would collide with the
    // StatusPill in the base-state assertions. Live-strip tests pass an explicit
    // `live` via makeLive().
    live: { available: false },
    ...over,
  };
}

function makeSignal(over: Partial<TelemetrySignalHealth> = {}): TelemetrySignalHealth {
  return {
    state: 'healthy',
    last_success_at: '2026-07-23T12:00:00Z',
    last_success_age_seconds: 8,
    items_per_window: 0,
    last_error: null,
    last_error_at: null,
    pods_reporting: 1,
    ...over,
  };
}

function makeLive(
  traces: Partial<TelemetrySignalHealth>,
  metrics: Partial<TelemetrySignalHealth>,
): SystemHealthTelemetryLive {
  return {
    available: true,
    window_seconds: 60,
    pods_reporting: 3,
    traces: makeSignal(traces),
    metrics: makeSignal(metrics),
  };
}

function makeResult(over: Partial<TelemetryTestResult> = {}): TelemetryTestResult {
  return {
    mode: 'export',
    outcome: 'success',
    endpoint: 'otel-collector.internal:4317',
    protocol: 'grpc',
    duration_ms: 84,
    detail: 'Canary span accepted by the collector — the export path from this pod is working. Worker and beat pods export independently and carry most of the volume; the live export strip covers them.',
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

  it('emits the chart\'s observability.otlp block, never a top-level envFrom (#2879)', () => {
    // #2860 fixed the YAML SHAPE (`extraEnv:` list -> `env:` map) but left the
    // mechanism wrong. Three defects lived in the four lines this replaced:
    //   1. a top-level `envFrom:` list CLOBBERS the operator's app-secret list —
    //      Helm replaces lists, so `trueppm-env` (SECRET_KEY / ALLOWED_HOSTS /
    //      INTEGRATION_ENCRYPTION_KEY, validated at settings-import time) vanished
    //      and the migrate init container crash-looped;
    //   2. `envFrom` + `secretRef` needs the Secret KEY to be literally
    //      OTEL_EXPORTER_OTLP_HEADERS, which the documented `--from-literal=headers=`
    //      recipe never produces;
    //   3. raw `env:` entries lose TRUEPPM_POD_NAME + every exportHealth knob, and
    //      lose outright to observability.otlp if both are ever set.
    render(
      <TelemetryCard
        telemetry={makeTelemetry({ enabled: false, endpoint: '', endpoint_configured: false })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Helm values' }));
    const snippet = screen.getByText(/helm upgrade trueppm/).textContent ?? '';

    // The chart's first-class block, matching packages/helm/values.yaml exactly.
    expect(snippet).toContain('observability:');
    expect(snippet).toContain('  otlp:');
    expect(snippet).toContain('    endpoint: "http://tempo.observability.svc:4317"');
    expect(snippet).toContain('    protocol: "grpc"');
    expect(snippet).toContain('    serviceName: "trueppm-api"');
    expect(snippet).toContain('    enabled: true');
    // The Env-vars tab sets a sampler; the Helm tab used to contradict it.
    expect(snippet).toContain('    tracesSampler: "parentbased_traceidratio"');
    expect(snippet).toContain('    tracesSamplerArg: "0.1"');

    // No key that would replace an operator list or invent a key no template reads.
    expect(snippet).not.toContain('extraEnv');
    expect(snippet).not.toMatch(/^envFrom:/m);
    expect(snippet).not.toMatch(/^env:/m);
    // The Secret is referenced through headersSecret (which maps ANY key name onto
    // OTEL_EXPORTER_OTLP_HEADERS), not through a raw secretRef.
    expect(snippet).toContain('headersSecret:');
    expect(snippet).not.toContain('secretRef:');
  });

  it('switches the snippet to Helm values when the Helm segment is clicked', () => {
    render(<TelemetryCard telemetry={makeTelemetry({ enabled: false, endpoint: '', endpoint_configured: false })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Helm values' }));
    expect(screen.getByText(/helm upgrade trueppm/)).toBeInTheDocument();
    expect(screen.getByText(/headersSecret:/)).toBeInTheDocument();
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

describe('TelemetryCard — live export strip (#2109)', () => {
  it('shows per-signal counts and last-success age when healthy', () => {
    const live = makeLive({ items_per_window: 1204 }, { items_per_window: 340 });
    render(<TelemetryCard telemetry={makeTelemetry({ live })} />);
    expect(screen.getByText(/Live export/)).toBeInTheDocument();
    expect(screen.getByText(/1,204 spans/)).toBeInTheDocument();
    expect(screen.getByText(/340 metric points/)).toBeInTheDocument();
    // age is server-computed; both healthy rows render "· 8s ago".
    expect(screen.getAllByText(/8s ago/).length).toBeGreaterThanOrEqual(1);
    // No alert when everything is healthy.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('raises an assertive alert with the error string when export is failing', () => {
    const live = makeLive(
      { state: 'healthy', items_per_window: 12 },
      { state: 'failing', last_error: 'connection refused', last_error_at: '2026-07-23T11:00:00Z' },
    );
    render(<TelemetryCard telemetry={makeTelemetry({ live })} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Export failing/);
    expect(alert).toHaveTextContent(/connection refused/);
  });

  it('shows a stalled alert when the metrics heartbeat has gone silent', () => {
    const live = makeLive(
      { state: 'idle' },
      { state: 'stalled', last_success_age_seconds: 22320, last_error: null },
    );
    render(<TelemetryCard telemetry={makeTelemetry({ live })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Export stalled/);
  });

  it('renders a quiet idle signal without an alarm', () => {
    const live = makeLive({ state: 'idle' }, { state: 'healthy', items_per_window: 340 });
    render(<TelemetryCard telemetry={makeTelemetry({ live })} />);
    expect(screen.getByText(/Idle — no recent data/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falls back to a muted note when the metrics store is unreachable', () => {
    render(<TelemetryCard telemetry={makeTelemetry({ live: { available: false } })} />);
    expect(screen.getByText(/Live export stats are unavailable/)).toBeInTheDocument();
    // The config posture is still shown.
    expect(screen.getByText('otel-collector.internal:4317')).toBeInTheDocument();
  });

  // #2880: the strip reports "8s ago · 1,204 spans", numbers that are only true at
  // fetch time. It shipped onto a page pinned to `poll: false` hours earlier, and
  // `refetch` reached the error branch's Retry button only — so a stall that began
  // after page load could never surface. The success path needs its own affordance.
  it('re-reads the strip on demand when a refresh handler is supplied', () => {
    const onRefresh = vi.fn();
    const live = makeLive({ items_per_window: 1204 }, { items_per_window: 340 });
    render(<TelemetryCard telemetry={makeTelemetry({ live })} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh live export stats' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('offers refresh on the unavailable branch too — that is where a stall shows', () => {
    const onRefresh = vi.fn();
    render(
      <TelemetryCard telemetry={makeTelemetry({ live: { available: false } })} onRefresh={onRefresh} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh live export stats' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the refresh control while a fetch is in flight', () => {
    const live = makeLive({ items_per_window: 1204 }, { items_per_window: 340 });
    render(
      <TelemetryCard telemetry={makeTelemetry({ live })} onRefresh={vi.fn()} isRefreshing />,
    );
    expect(screen.getByRole('button', { name: 'Refresh live export stats' })).toBeDisabled();
  });

  it('renders no refresh control when the caller supplies no handler', () => {
    const live = makeLive({ items_per_window: 1204 }, { items_per_window: 340 });
    render(<TelemetryCard telemetry={makeTelemetry({ live })} />);
    expect(
      screen.queryByRole('button', { name: 'Refresh live export stats' }),
    ).not.toBeInTheDocument();
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
    expect(screen.getByText(/the export path from this pod is working/i)).toBeInTheDocument();
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
