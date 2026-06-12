import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';

import { SprintForecastChips } from './SprintForecastChips';

const burndownMock = vi.hoisted(() => vi.fn());
const forecastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useSprints', () => ({
  useSprintBurndown: burndownMock,
  useSprintForecast: forecastMock,
}));

const READY_FORECAST = {
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

beforeEach(() => {
  vi.clearAllMocks();
  burndownMock.mockReturnValue({ data: undefined });
  forecastMock.mockReturnValue({ data: undefined });
});

describe('SprintForecastChips', () => {
  it('renders the release-horizon chip from a ready forecast, linking to overview', () => {
    forecastMock.mockReturnValue({ data: READY_FORECAST });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(screen.getByText(/clears in ~3 sprints/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Release horizon/ });
    expect(link.getAttribute('href')).toBe('/projects/p1/overview');
  });

  it('renders a "behind" sprint-finish chip from burn pace', () => {
    burndownMock.mockReturnValue({ data: { burn_status: 'behind', trend_points: -12 } });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(screen.getByText(/12 pts behind at this pace/)).toBeTruthy();
  });

  it('renders an "ahead" sprint-finish chip', () => {
    burndownMock.mockReturnValue({ data: { burn_status: 'ahead', trend_points: 6 } });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(screen.getByText(/finish ahead/)).toBeTruthy();
  });

  it('hides the release-horizon chip when velocity is suppressed', () => {
    forecastMock.mockReturnValue({ data: { ...READY_FORECAST, velocity_suppressed: true } });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(screen.queryByText(/clears in/)).toBeNull();
  });

  it('renders nothing when there is neither a burn status nor a ready forecast', () => {
    burndownMock.mockReturnValue({ data: { burn_status: 'no_data', trend_points: null } });
    forecastMock.mockReturnValue({ data: { ...READY_FORECAST, status: 'warming_up' } });
    const { container } = renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(container.querySelector('[data-testid="sprint-forecast-chips"]')).toBeNull();
  });
});
