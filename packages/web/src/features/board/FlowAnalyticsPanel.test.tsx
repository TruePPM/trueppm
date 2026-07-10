import type { ReactNode } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderWithProviders } from '@/test/utils';
import type { FlowMetrics, SprintForecast } from '@/hooks/useSprints';
import { formatShortDate } from '@/features/sprints/sprintMath';
import { FlowAnalyticsPanel } from './FlowAnalyticsPanel';

// Recharts needs ResizeObserver + real dimensions; stub ResponsiveContainer so it
// renders children in jsdom (mirrors BurnChart.test).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div style={{ width: 400, height: 144 }}>{children}</div>
    ),
  };
});

const useFlowMetricsMock = vi.hoisted(() => vi.fn());
const useSprintForecastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useSprints', () => ({
  useFlowMetrics: useFlowMetricsMock,
  useSprintForecast: useSprintForecastMock,
}));

function setMetrics(data: FlowMetrics | undefined, extra: { isLoading?: boolean; isError?: boolean } = {}) {
  useFlowMetricsMock.mockReturnValue({ data, isLoading: false, isError: false, ...extra });
}

function setForecast(
  data: SprintForecast | undefined,
  extra: { isLoading?: boolean; isError?: boolean } = {},
) {
  useSprintForecastMock.mockReturnValue({ data, isLoading: false, isError: false, ...extra });
}

const FORECAST_READY: SprintForecast = {
  status: 'ready',
  remaining_points: null,
  remaining_count: 18,
  sample_count: 8,
  p50_sprints: null,
  p80_sprints: null,
  p50_date: '2026-07-28',
  p80_date: '2026-08-11',
  p95_date: '2026-08-25',
  basis: 'monte_carlo',
  forecast_basis: 'throughput',
  velocity_suppressed: false,
};

const POPULATED: FlowMetrics = {
  window_days: 90,
  since: '2026-04-01',
  until: '2026-06-30',
  cycle_time: { p50: 4, p80: 7, p95: 12 },
  lead_time: { p50: 9, p80: 14, p95: 21 },
  cfd: [
    { date: '2026-06-29', counts: { BACKLOG: 5, NOT_STARTED: 3, IN_PROGRESS: 6, REVIEW: 2, COMPLETE: 24 } },
    { date: '2026-06-30', counts: { BACKLOG: 4, NOT_STARTED: 3, IN_PROGRESS: 5, REVIEW: 2, COMPLETE: 26 } },
  ],
  throughput: [
    { week_start: '2026-06-15', completed_count: 6 },
    { week_start: '2026-06-22', completed_count: 9 },
  ],
  data_integrity: { bulk_moved_count: 0, backdated_count: 0, missing_transition_count: 0 },
  flow_metrics_suppressed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  setMetrics(undefined);
  setForecast(undefined);
});

function expand() {
  fireEvent.click(screen.getByTestId('flow-analytics-toggle'));
}

describe('FlowAnalyticsPanel', () => {
  it('is collapsed by default — body is not rendered until opened (VoC Priya)', () => {
    setMetrics(POPULATED);
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    const toggle = screen.getByTestId('flow-analytics-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('flow-analytics-body')).toBeNull();
  });

  it('shows the charts and a legible privacy caption when expanded and in-audience', () => {
    setMetrics(POPULATED);
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    expand();
    expect(screen.getByTestId('flow-analytics-charts')).toBeTruthy();
    // The privacy guarantee must be legible in the UI, not doc-only (VoC Morgan/Priya).
    expect(screen.getByText(/aggregate only — no individual breakdown/i)).toBeTruthy();
    // Cycle/lead percentiles render as a stat strip.
    expect(screen.getByTestId('cycle-lead-strip')).toBeTruthy();
  });

  it('paints chart fills with rgb(var(--…)) tokens, never the dead --color- prefix (issue 1791)', () => {
    // The dead `var(--color-…)` refs fell back to SVG-default black — illegible on
    // the dark navy surface. The correct wrapped form must reach the rendered SVG.
    setMetrics(POPULATED);
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    expand();
    const charts = screen.getByTestId('flow-analytics-charts');
    const markup = charts.innerHTML;
    expect(markup).toContain('rgb(var(--');
    expect(markup).not.toContain('var(--color-');
  });

  it('renders a content-free wall when flow metrics are suppressed (ADR-0104)', () => {
    setMetrics({ ...POPULATED, flow_metrics_suppressed: true });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    expand();
    expect(screen.getByTestId('flow-metrics-suppressed')).toBeTruthy();
    expect(screen.queryByTestId('flow-analytics-charts')).toBeNull();
    // No numbers leak through the wall.
    expect(screen.queryByText('24')).toBeNull();
  });

  it('explains the empty state instead of a broken chart', () => {
    setMetrics({
      ...POPULATED,
      cycle_time: { p50: null, p80: null, p95: null },
      throughput: [{ week_start: '2026-06-22', completed_count: 0 }],
    });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    expand();
    expect(screen.getByTestId('flow-analytics-empty')).toBeTruthy();
  });

  it('surfaces a fetch error inline', () => {
    setMetrics(undefined, { isError: true });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    expand();
    expect(screen.getByTestId('flow-analytics-error')).toBeTruthy();
  });

  it('notes data-integrity caveats only when a count is non-zero', () => {
    setMetrics({
      ...POPULATED,
      data_integrity: { bulk_moved_count: 3, backdated_count: 0, missing_transition_count: 1 },
    });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" />);
    expand();
    const note = screen.getByTestId('flow-data-integrity');
    expect(note.textContent).toContain('3 bulk-moved');
    expect(note.textContent).toContain('1 missing transitions');
    expect(note.textContent).not.toContain('backdated');
  });
});

describe('FlowAnalyticsPanel — throughput forecast (issue 1280)', () => {
  it('does not render the forecast card for a sprint-cadence board (unaffected)', () => {
    setMetrics(POPULATED);
    setForecast(FORECAST_READY);
    // No boardCadence prop → defaults to a non-continuous board.
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" boardCadence="sprint" />);
    expand();
    expect(screen.queryByTestId('throughput-forecast')).toBeNull();
  });

  it('headlines P80 as "~N weeks / by <date>" for a continuous board', () => {
    // Freeze "now" at a UTC instant so the derived week count is deterministic
    // regardless of the test runner's timezone: 2026-06-30 → P80 2026-08-11 is
    // exactly 42 days = 6 weeks (weeksFromNow compares UTC midnights, web-rule 189).
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-30T00:00:00Z'));
    try {
      setMetrics(POPULATED);
      setForecast(FORECAST_READY);
      renderWithProviders(<FlowAnalyticsPanel projectId="p1" boardCadence="continuous" />);
      expand();
      const card = screen.getByTestId('throughput-forecast-ready');
      // P80 is the headline: "~6 weeks — by <P80 date> (P80)".
      expect(card.textContent).toMatch(/~\s*6\s*weeks/);
      expect(card.textContent).toContain(formatShortDate('2026-08-11'));
      expect(card.textContent).toContain('(P80)');
      // Remaining scope is surfaced.
      expect(card.textContent).toContain('18');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shows all three percentiles (P50/P80/P95) in the detail line', () => {
    setMetrics(POPULATED);
    setForecast(FORECAST_READY);
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" boardCadence="continuous" />);
    expand();
    const card = screen.getByTestId('throughput-forecast');
    expect(card.textContent).toContain(formatShortDate('2026-07-28')); // P50
    expect(card.textContent).toContain(formatShortDate('2026-08-25')); // P95
    expect(card.textContent).toContain('weekly throughput');
  });

  it('explains the honest insufficiency state instead of a fake forecast', () => {
    setMetrics(POPULATED);
    setForecast({
      ...FORECAST_READY,
      status: 'insufficient_flow_history',
      sample_count: 2,
      p50_date: null,
      p80_date: null,
      p95_date: null,
    });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" boardCadence="continuous" />);
    expand();
    expect(screen.getByTestId('throughput-forecast-insufficient')).toBeTruthy();
    expect(screen.queryByTestId('throughput-forecast-ready')).toBeNull();
  });

  it('renders a team-private message when the velocity signal is suppressed (ADR-0104)', () => {
    setMetrics(POPULATED);
    setForecast({
      ...FORECAST_READY,
      velocity_suppressed: true,
      remaining_count: null,
      sample_count: 0,
      p50_date: null,
      p80_date: null,
      p95_date: null,
    });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" boardCadence="continuous" />);
    expand();
    expect(screen.getByTestId('throughput-forecast-suppressed')).toBeTruthy();
    // No forecast numbers leak through the privacy wall.
    expect(screen.queryByTestId('throughput-forecast-ready')).toBeNull();
  });

  it('surfaces a forecast fetch error inline without breaking the charts', () => {
    setMetrics(POPULATED);
    setForecast(undefined, { isError: true });
    renderWithProviders(<FlowAnalyticsPanel projectId="p1" boardCadence="continuous" />);
    expand();
    expect(screen.getByTestId('throughput-forecast-error')).toBeTruthy();
    // The historical charts still render — the forecast error is isolated.
    expect(screen.getByTestId('flow-analytics-charts')).toBeTruthy();
  });
});
