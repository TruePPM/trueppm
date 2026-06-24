import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { MemoryRouter } from 'react-router';

vi.mock('@/hooks/useSprints', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useSprints')>('@/hooks/useSprints');
  return { ...actual, useProjectForecast: vi.fn() };
});

import { VelocityForecastLine } from './VelocityForecastLine';
import { useProjectForecast, type ProjectForecast } from '@/hooks/useSprints';

const useProjectForecastMock = vi.mocked(useProjectForecast);

function forecast(overrides: Partial<ProjectForecast> = {}): ProjectForecast {
  return {
    velocity: {
      sprints: [
        {
          id: '1',
          name: 'S1',
          start_date: '2026-01-01',
          finish_date: '2026-01-14',
          committed_points: 30,
          completed_points: 28,
          committed_task_count: 6,
          completed_task_count: 5,
          exclude_from_velocity: false,
        },
      ],
      rolling_avg_points: 28,
      rolling_stdev_points: 4,
      forecast_range_low: 24,
      forecast_range_high: 32,
      rolling_avg_tasks: null,
      rolling_stdev_tasks: null,
      team_velocity_per_day: 2,
      excluded_count: 0,
    },
    remaining_committed_points: 60,
    sprints_to_complete_low: 2,
    sprints_to_complete_high: 3,
    milestones: [],
    ...overrides,
  };
}

function mockForecast(data: ProjectForecast | undefined, isLoading = false) {
  useProjectForecastMock.mockReturnValue({ data, isLoading } as unknown as ReturnType<
    typeof useProjectForecast
  >);
}

function renderLine(props: Partial<Parameters<typeof VelocityForecastLine>[0]> = {}) {
  return render(
    <MemoryRouter>
      <VelocityForecastLine
        projectId="p1"
        targetMilestoneId={null}
        enabled
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('VelocityForecastLine (#607)', () => {
  it('renders nothing when disabled (velocity suppressed)', () => {
    mockForecast(undefined);
    const { container } = renderLine({ enabled: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the backlog sprints-to-complete forecast when no milestone is bound', () => {
    mockForecast(forecast());
    renderLine();
    const line = screen.getByTestId('velocity-forecast-line');
    expect(line).toHaveTextContent(/~2–3 more sprints to clear 60 pts/i);
  });

  it('renders the milestone P50/P80 forecast when the active sprint is bound', () => {
    mockForecast(
      forecast({
        milestones: [
          {
            id: 'fs1',
            milestone_id: 'm-1',
            milestone_name: 'Login redesign',
            basis: 'monte_carlo',
            cpm_finish: '2026-09-01',
            p50: '2026-09-10',
            p80: '2026-09-24',
            velocity_low: 24,
            velocity_high: 32,
            confidence: 'medium',
            unmodeled_dependency: false,
            taken_at: '2026-06-01T00:00:00Z',
          },
        ],
      }),
    );
    renderLine({ targetMilestoneId: 'm-1' });
    const line = screen.getByTestId('velocity-forecast-line');
    expect(line).toHaveTextContent(/Login redesign/);
    expect(line).toHaveTextContent(/P50/);
    expect(line).toHaveTextContent(/80%/);
  });

  it('#1094: a velocity_band milestone reads as an estimate, not P50/P80', () => {
    mockForecast(
      forecast({
        milestones: [
          {
            id: 'fs1',
            milestone_id: 'm-1',
            milestone_name: 'Login redesign',
            basis: 'velocity_band',
            cpm_finish: '2026-09-01',
            p50: '2026-09-10',
            p80: '2026-09-24',
            velocity_low: 24,
            velocity_high: 32,
            confidence: 'medium',
            unmodeled_dependency: false,
            taken_at: '2026-06-01T00:00:00Z',
          },
        ],
      }),
    );
    renderLine({ targetMilestoneId: 'm-1' });
    const line = screen.getByTestId('velocity-forecast-line');
    expect(line).toHaveTextContent(/Login redesign/);
    // No Monte-Carlo percentile vocabulary on a deterministic velocity-band estimate.
    expect(line).not.toHaveTextContent(/P50/);
    expect(line).not.toHaveTextContent(/80%/);
    expect(line).toHaveTextContent(/est\./);
    expect(line).toHaveTextContent(/velocity estimate/i);
  });

  it('falls back to the backlog forecast when the bound milestone has no snapshot', () => {
    mockForecast(forecast({ milestones: [] }));
    renderLine({ targetMilestoneId: 'm-1' });
    expect(screen.getByTestId('velocity-forecast-line')).toHaveTextContent(/more sprints/i);
  });

  it('shows the actionable warm-up nudge with N-of-3 progress and input links below the floor (#1052)', () => {
    // One closed sprint → "Sprint 2 of 3" (closed + the one in flight).
    mockForecast(forecast({ sprints_to_complete_low: null, sprints_to_complete_high: null }));
    renderLine();
    const line = screen.getByTestId('velocity-forecast-line');
    expect(line).toHaveTextContent(/Sprint 2 of 3 toward your first forecast/i);
    expect(screen.getByRole('link', { name: /story points on your backlog/i })).toHaveAttribute(
      'href',
      '/projects/p1/product-backlog',
    );
    expect(screen.getByRole('link', { name: /capacity set/i })).toHaveAttribute(
      'href',
      '/projects/p1/board',
    );
  });

  it('drops the N-of-3 progress framing once the closed-sprint floor is reached but the band is still null (#1052)', () => {
    // Three closed sprints but no band (e.g. no story points to re-pace) — the
    // progress line would read as stalled, so only the input nudges remain.
    const threeClosed = forecast({
      sprints_to_complete_low: null,
      sprints_to_complete_high: null,
    });
    threeClosed.velocity.sprints = [
      threeClosed.velocity.sprints[0],
      { ...threeClosed.velocity.sprints[0], id: '2', name: 'S2' },
      { ...threeClosed.velocity.sprints[0], id: '3', name: 'S3' },
    ];
    mockForecast(threeClosed);
    renderLine();
    const line = screen.getByTestId('velocity-forecast-line');
    expect(line).not.toHaveTextContent(/of 3 toward/i);
    expect(line).toHaveTextContent(/not enough signal/i);
    expect(screen.getByRole('link', { name: /story points on your backlog/i })).toBeInTheDocument();
  });

  it('reports a fully-delivered scope when no committed backlog remains', () => {
    mockForecast(forecast({ remaining_committed_points: 0 }));
    renderLine();
    expect(screen.getByTestId('velocity-forecast-line')).toHaveTextContent(/fully delivered/i);
  });

  it('renders a loading placeholder while fetching', () => {
    mockForecast(undefined, true);
    renderLine();
    expect(screen.getByRole('status', { name: /loading forecast/i })).toBeInTheDocument();
  });
});
