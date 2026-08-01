import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { MemoryRouter } from 'react-router';

vi.mock('@/hooks/useSprints', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useSprints')>('@/hooks/useSprints');
  return { ...actual, useProjectForecast: vi.fn(), useProjectVelocity: vi.fn() };
});

import { MilestoneBridgeForecast } from './MilestoneBridgeForecast';
import {
  useProjectForecast,
  useProjectVelocity,
  type ForecastSnapshot,
  type ProjectForecast,
} from '@/hooks/useSprints';

const forecastMock = vi.mocked(useProjectForecast);
const velocityMock = vi.mocked(useProjectVelocity);

function snapshot(overrides: Partial<ForecastSnapshot> = {}): ForecastSnapshot {
  return {
    id: 'fs1',
    milestone_id: 'm-1',
    milestone_name: 'Foundation Complete',
    basis: 'velocity_band',
    cpm_finish: '2026-04-21',
    p50: '2026-04-24',
    p80: '2026-05-02',
    velocity_low: 24,
    velocity_high: 32,
    confidence: 'medium',
    unmodeled_dependency: false,
    taken_at: '2026-06-01T00:00:00Z',
    previous: null,
    previous_sprint_name: null,
    ...overrides,
  };
}

function forecast(milestones: ForecastSnapshot[]): ProjectForecast {
  return {
    velocity: {} as ProjectForecast['velocity'],
    remaining_committed_points: 34,
    sprints_to_complete_low: 2,
    sprints_to_complete_high: 3,
    milestones,
  };
}

function setup(
  milestones: ForecastSnapshot[] | null,
  { suppressed = false, velocityLoading = false }: { suppressed?: boolean; velocityLoading?: boolean } = {},
) {
  velocityMock.mockReturnValue({
    data: velocityLoading ? undefined : { velocity_suppressed: suppressed },
  } as unknown as ReturnType<typeof useProjectVelocity>);
  forecastMock.mockReturnValue({
    data: milestones == null ? undefined : forecast(milestones),
  } as unknown as ReturnType<typeof useProjectForecast>);
  return render(
    <MemoryRouter>
      <MilestoneBridgeForecast
        projectId="p1"
        targetMilestoneId="m-1"
        onCriticalPath={null}
        totalFloatDays={5}
      />
    </MemoryRouter>,
  );
}

describe('MilestoneBridgeForecast (#730)', () => {
  // #2640 — this block previously asserted `toBeEmptyDOMElement()`. That was the
  // defect: velocity is team-private BY DEFAULT, so on a default-configured project
  // a PM or PMO reader lost the deterministic schedule read too, and saw a blank
  // region with nothing to say why. The CPM finish carries no team-performance
  // content, and /forecast/ deliberately serves it to a suppressed reader.
  describe('velocity suppressed (ADR-0104) — the schedule read survives', () => {
    it('still renders the Schedule (CPM) column and its date', () => {
      setup([snapshot()], { suppressed: true });
      const region = screen.getByTestId('milestone-bridge-forecast');
      expect(region).toHaveTextContent(/Schedule \(CPM\)/);
      expect(region).toHaveTextContent(/Apr 21/);
    });

    it('keeps the float annotation on the schedule column', () => {
      setup([snapshot()], { suppressed: true });
      expect(screen.getByLabelText(/5 days of float remaining/)).toBeInTheDocument();
    });

    it('replaces the velocity band with an explicit policy notice, not a blank', () => {
      setup([snapshot()], { suppressed: true });
      expect(screen.getByTestId('milestone-bridge-velocity-suppressed')).toHaveTextContent(
        /Hidden by this team.s signal settings/,
      );
    });

    it('still withholds the band itself and the projection line', () => {
      setup([snapshot()], { suppressed: true });
      const region = screen.getByTestId('milestone-bridge-forecast');
      expect(region).not.toHaveTextContent(/est\./);
      expect(region).not.toHaveTextContent(/If velocity holds/);
      expect(region).not.toHaveTextContent(/pts\./);
    });
  });

  it('renders nothing when the sprint is unbound, even for an in-audience reader', () => {
    // The genuinely-absent cases must stay silent — only the suppressed case changed.
    velocityMock.mockReturnValue({
      data: { velocity_suppressed: false },
    } as unknown as ReturnType<typeof useProjectVelocity>);
    forecastMock.mockReturnValue({
      data: forecast([snapshot()]),
    } as unknown as ReturnType<typeof useProjectForecast>);
    const { container } = render(
      <MemoryRouter>
        <MilestoneBridgeForecast
          projectId="p1"
          targetMilestoneId={null}
          onCriticalPath={null}
          totalFloatDays={5}
        />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the velocity read is still loading', () => {
    const { container } = setup([snapshot()], { velocityLoading: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the forecast payload is a malformed (catch-all) shape', () => {
    // #1190 guard: an e2e leaning on a `{count,results}` catch-all route hands us
    // no `milestones` array — the component must null-render, not crash `.find`.
    velocityMock.mockReturnValue({
      data: { velocity_suppressed: false },
    } as unknown as ReturnType<typeof useProjectVelocity>);
    forecastMock.mockReturnValue({
      data: { count: 0, next: null, previous: null, results: [] },
    } as unknown as ReturnType<typeof useProjectForecast>);
    const { container } = render(
      <MemoryRouter>
        <MilestoneBridgeForecast
          projectId="p1"
          targetMilestoneId="m-1"
          onCriticalPath={null}
          totalFloatDays={5}
        />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no snapshot matches the bound milestone', () => {
    const { container } = setup([snapshot({ milestone_id: 'other' })]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the matched snapshot has no CPM anchor', () => {
    const { container } = setup([snapshot({ cpm_finish: null })]);
    expect(container).toBeEmptyDOMElement();
  });

  it('web-rule 166: a velocity_band snapshot reads as an estimate — no percentile labels', () => {
    setup([snapshot({ basis: 'velocity_band' })]);
    const region = screen.getByTestId('milestone-bridge-forecast');
    expect(region).toHaveTextContent(/est\./);
    expect(region).toHaveTextContent(/\(velocity estimate\)/);
    // Schedule (CPM) exact date is shown; velocity side must NOT borrow percentiles.
    expect(region).toHaveTextContent(/Schedule \(CPM\)/);
    expect(region).not.toHaveTextContent(/P80/);
    expect(region).not.toHaveTextContent(/P50/);
  });

  it('web-rule 166: a monte_carlo snapshot may wear P80/P50 and drops the estimate qualifier', () => {
    setup([snapshot({ basis: 'monte_carlo' })]);
    const region = screen.getByTestId('milestone-bridge-forecast');
    expect(region).toHaveTextContent(/P80/);
    expect(region).toHaveTextContent(/P50/);
    expect(region).not.toHaveTextContent(/\(velocity estimate\)/);
  });

  /**
   * #2495 scope boundary, asserted so it can't be widened by accident. The clamped
   * sampler that makes a percentile a floor is `_sample_backlog_sprint_counts` behind
   * `/sprint-forecast/`. This card reads `/forecast/`, whose milestone snapshots are
   * written `velocity_band` (services.py `_velocity_band_percentiles`) — a deterministic
   * band, not a simulation, and not clamped. Its existing "(velocity estimate)" is the
   * correct and sufficient qualifier; adding a floor caveat here would claim a bias
   * this number does not have.
   */
  it('#2495: the velocity-band read is not clamped, so it carries no floor caveat', () => {
    setup([snapshot({ basis: 'velocity_band' })]);
    const region = screen.getByTestId('milestone-bridge-forecast');
    expect(region).toHaveTextContent(/\(velocity estimate\)/);
    expect(region).not.toHaveTextContent(/a floor, not a percentile/i);
    expect(screen.queryByRole('button', { name: /forecast horizon/i })).toBeNull();
  });

  it('shows the CPM delta chip with sprint attribution when the finish slipped', () => {
    setup([
      snapshot({
        cpm_finish: '2026-04-21',
        previous: {
          cpm_finish: '2026-04-18',
          p50: '2026-04-20',
          p80: '2026-04-28',
          velocity_low: 24,
          velocity_high: 32,
          basis: 'velocity_band',
          confidence: 'medium',
          taken_at: '2026-05-01T00:00:00Z',
        },
        previous_sprint_name: 'Sprint 6',
      }),
    ]);
    const region = screen.getByTestId('milestone-bridge-forecast');
    expect(region).toHaveTextContent(/\+3d later/);
    expect(region).toHaveTextContent(/since Sprint 6/);
    // Direction stated in words for AT, not color alone (rule 120).
    expect(
      screen.getByLabelText(/Scheduled finish moved 3 days later.*since Sprint 6/),
    ).toBeInTheDocument();
  });

  it('reads "since the last forecast" when the close cannot be attributed to one sprint', () => {
    setup([
      snapshot({
        cpm_finish: '2026-04-15',
        previous: { ...prevOf('2026-04-21') },
        previous_sprint_name: null,
      }),
    ]);
    const region = screen.getByTestId('milestone-bridge-forecast');
    expect(region).toHaveTextContent(/-6d earlier/);
    expect(region).toHaveTextContent(/since the last forecast/);
  });

  it('hides the delta chip when there is no prior snapshot', () => {
    setup([snapshot({ previous: null })]);
    expect(screen.getByTestId('milestone-bridge-forecast')).not.toHaveTextContent(/→/);
  });

  it('hides the delta chip when the CPM finish did not move', () => {
    setup([
      snapshot({ cpm_finish: '2026-04-21', previous: { ...prevOf('2026-04-21') } }),
    ]);
    expect(screen.getByTestId('milestone-bridge-forecast')).not.toHaveTextContent(/→/);
  });

  it('renders the "if velocity holds" projection from the sprints-to-complete range', () => {
    setup([snapshot()]);
    expect(screen.getByTestId('milestone-bridge-forecast')).toHaveTextContent(
      /If velocity holds, ~2–3 more sprints to clear 34 pts\./,
    );
  });

  /**
   * #2653 scope boundary, paired with the #2495 scope-boundary test above. This
   * projection reads the same `sprints_to_complete_low/high` field as
   * VelocityForecastLine's BacklogForecast branch — a plain avg±1σ division
   * (`_sprints_to_complete`), not the clamped-horizon bootstrap sampler behind
   * useSprintForecast() that ForecastHorizonHelp exists to caveat.
   */
  it('#2653: the "if velocity holds" projection is not clamped, so it carries no floor caveat', () => {
    setup([snapshot()]);
    expect(screen.getByTestId('milestone-bridge-forecast')).toHaveTextContent(
      /If velocity holds/,
    );
    expect(screen.queryByRole('button', { name: /forecast horizon/i })).toBeNull();
  });

  it('shows a warm-up reason instead of a bare chip below the velocity floor (rule 119)', () => {
    setup([snapshot({ p50: null, p80: null })]);
    expect(screen.getByTestId('milestone-bridge-forecast')).toHaveTextContent(
      /Estimate pending — building velocity/,
    );
  });
});

function prevOf(cpm: string): NonNullable<ForecastSnapshot['previous']> {
  return {
    cpm_finish: cpm,
    p50: '2026-04-20',
    p80: '2026-04-28',
    velocity_low: 24,
    velocity_high: 32,
    basis: 'velocity_band',
    confidence: 'medium',
    taken_at: '2026-05-01T00:00:00Z',
  };
}
