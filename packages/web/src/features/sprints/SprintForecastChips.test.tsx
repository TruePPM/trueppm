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

const THROUGHPUT_FORECAST = {
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

beforeEach(() => {
  vi.clearAllMocks();
  burndownMock.mockReturnValue({ data: undefined });
  forecastMock.mockReturnValue({ data: undefined });
});

describe('SprintForecastChips', () => {
  // The chip content is JSX (numbers in .tppm-mono spans, rule 8c), so assert on
  // the normalized textContent rather than a single text node.
  const chipsText = () =>
    screen.getByTestId('sprint-forecast-chips').textContent?.replace(/\s+/g, ' ') ?? '';

  it('renders the release-horizon chip from a ready forecast, linking to overview', () => {
    forecastMock.mockReturnValue({ data: READY_FORECAST });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(chipsText()).toContain('clears in ~3 sprints (P80 4)');
    const link = screen.getByRole('link', { name: /Release horizon/ });
    expect(link.getAttribute('href')).toBe('/projects/p1/overview');
  });

  it('renders a throughput release-horizon chip with item counts + dates, no sprint vocab', () => {
    forecastMock.mockReturnValue({ data: THROUGHPUT_FORECAST });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    const text = chipsText();
    expect(text).toContain('At current throughput, ~24 items clear by');
    // web-rule 175: a throughput chip never claims "sprints".
    expect(text).not.toContain('sprint');
  });

  it('renders a "behind" sprint-finish chip from burn pace', () => {
    burndownMock.mockReturnValue({ data: { burn_status: 'behind', trend_points: -12 } });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(chipsText()).toContain('12 pts behind at this pace');
  });

  it('renders an "ahead" sprint-finish chip', () => {
    burndownMock.mockReturnValue({ data: { burn_status: 'ahead', trend_points: 6 } });
    renderWithRouter(<SprintForecastChips projectId="p1" sprintId="s1" />);
    expect(chipsText()).toContain('finish ahead (+6 pts)');
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
