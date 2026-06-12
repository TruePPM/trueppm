import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
  sample_count: 3,
  p50_sprints: 3,
  p80_sprints: 4,
  p50_date: '2026-08-01',
  p80_date: '2026-08-15',
  basis: 'monte_carlo',
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
});
