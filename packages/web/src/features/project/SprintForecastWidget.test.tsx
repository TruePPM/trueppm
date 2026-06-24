import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';

import { SprintForecastWidget } from './SprintForecastWidget';
import type { SprintForecast } from '@/hooks/useSprints';

const useSprintForecastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useSprints', () => ({
  useSprintForecast: useSprintForecastMock,
}));

function setForecast(data: SprintForecast | undefined, isLoading = false) {
  useSprintForecastMock.mockReturnValue({ data, isLoading });
}

const READY: SprintForecast = {
  status: 'ready',
  remaining_points: 60,
  remaining_count: null,
  sample_count: 3,
  p50_sprints: 3,
  p80_sprints: 4,
  p50_date: '2026-08-01',
  p80_date: '2026-08-15',
  p95_date: '2026-08-29',
  basis: 'monte_carlo',
  forecast_basis: 'velocity',
  velocity_suppressed: false,
};

const THROUGHPUT_READY: SprintForecast = {
  status: 'ready',
  remaining_points: null,
  remaining_count: 24,
  sample_count: 8,
  p50_sprints: null,
  p80_sprints: null,
  p50_date: '2026-08-01',
  p80_date: '2026-08-15',
  p95_date: '2026-08-29',
  basis: 'monte_carlo',
  forecast_basis: 'throughput',
  velocity_suppressed: false,
};

describe('SprintForecastWidget', () => {
  it('renders the ready forecast with P50/P80 dates and sprint counts', () => {
    setForecast(READY);
    render(<SprintForecastWidget projectId="p1" />);
    expect(screen.getByTestId('forecast-ready')).toBeTruthy();
    expect(screen.getByText(/60/)).toBeTruthy();
    // Monte Carlo basis → P50/P80 vocabulary is allowed (web-rule 166).
    expect(screen.getByText(/P50/)).toBeTruthy();
    expect(screen.getByText(/P80/)).toBeTruthy();
  });

  it('renders the warming-up state until two sprints have closed', () => {
    setForecast({ ...READY, status: 'warming_up', p50_date: null, p80_date: null, sample_count: 1 });
    render(<SprintForecastWidget projectId="p1" />);
    expect(screen.getByTestId('forecast-warming-up')).toBeTruthy();
    expect(screen.queryByTestId('forecast-ready')).toBeNull();
  });

  it('renders the team-private wall when velocity is suppressed', () => {
    setForecast({ ...READY, velocity_suppressed: true });
    render(<SprintForecastWidget projectId="p1" />);
    expect(screen.getByTestId('forecast-suppressed')).toBeTruthy();
    expect(screen.queryByText(/P50/)).toBeNull();
  });

  it('renders nothing while loading', () => {
    setForecast(undefined, true);
    const { container } = render(<SprintForecastWidget projectId="p1" />);
    expect(container.firstChild).toBeNull();
  });

  it('branches to the throughput forecast — item counts + dates, no velocity/sprint vocab', () => {
    setForecast(THROUGHPUT_READY);
    render(<SprintForecastWidget projectId="p1" />);
    const body = screen.getByTestId('forecast-ready-throughput');
    const text = body.textContent ?? '';
    expect(text).toContain('24');
    expect(text.toLowerCase()).toContain('throughput');
    // web-rule 176: a throughput forecast never borrows velocity/sprint language.
    expect(text.toLowerCase()).not.toContain('velocity');
    expect(text.toLowerCase()).not.toContain('sprint');
    // It is a real Monte Carlo, so percentile vocabulary is still honest (rule 166).
    expect(text).toContain('P50');
  });

  it('explains insufficient flow history instead of a blank widget', () => {
    setForecast({
      ...THROUGHPUT_READY,
      status: 'insufficient_flow_history',
      p50_date: null,
      p80_date: null,
      p95_date: null,
      sample_count: 2,
    });
    render(<SprintForecastWidget projectId="p1" />);
    expect(screen.getByTestId('forecast-insufficient-flow')).toBeTruthy();
    expect(screen.getByText(/4 weeks of completed-work history/i)).toBeTruthy();
  });
});
