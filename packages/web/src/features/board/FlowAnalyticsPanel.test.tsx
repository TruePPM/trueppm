import type { ReactNode } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderWithProviders } from '@/test/utils';
import type { FlowMetrics } from '@/hooks/useSprints';
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
vi.mock('@/hooks/useSprints', () => ({
  useFlowMetrics: useFlowMetricsMock,
}));

function setMetrics(data: FlowMetrics | undefined, extra: { isLoading?: boolean; isError?: boolean } = {}) {
  useFlowMetricsMock.mockReturnValue({ data, isLoading: false, isError: false, ...extra });
}

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
