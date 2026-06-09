import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SprintPanel } from './SprintPanel';
import { makeSprint } from '@/features/sprints/sprintTestFixtures';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_VIEWER } from '@/lib/roles';
import type { ApiSprint } from '@/types';

const updateSprintMock = vi.fn();

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(),
}));
vi.mock('@/hooks/useSprints', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useSprints')>(
    '@/hooks/useSprints',
  );
  return {
    ...actual,
    useActiveSprint: vi.fn(),
    useProjectVelocity: vi.fn(),
    useProjectForecast: vi.fn(),
    useSprintMutations: vi.fn(),
  };
});
vi.mock('@/features/reports/BurnChart', () => ({
  BurnChart: ({ sprintId }: { sprintId: string }) => (
    <div data-testid="burn-chart">burn-chart:{sprintId}</div>
  ),
}));

import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import {
  useActiveSprint,
  useProjectVelocity,
  useProjectForecast,
  useSprintMutations,
  type ProjectVelocity,
} from '@/hooks/useSprints';

const useCurrentUserRoleMock = vi.mocked(useCurrentUserRole);
const useActiveSprintMock = vi.mocked(useActiveSprint);
const useProjectVelocityMock = vi.mocked(useProjectVelocity);
const useProjectForecastMock = vi.mocked(useProjectForecast);
const useSprintMutationsMock = vi.mocked(useSprintMutations);

function renderPanel(opts: {
  methodology?: 'WATERFALL' | 'AGILE' | 'HYBRID' | undefined;
  sprint?: ApiSprint | null;
  role?: number | null;
  velocity?: Partial<ProjectVelocity>;
} = {}) {
  const { methodology = 'AGILE', sprint = makeSprint({ state: 'ACTIVE' }), role = ROLE_SCHEDULER, velocity } = opts;
  useActiveSprintMock.mockReturnValue({ sprint, isLoading: false });
  useCurrentUserRoleMock.mockReturnValue({ role, isLoading: role === null });
  useProjectVelocityMock.mockReturnValue({
    data: velocity as ProjectVelocity | undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectVelocity>);
  useProjectForecastMock.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectForecast>);
  useSprintMutationsMock.mockReturnValue({
    updateSprint: { mutate: updateSprintMock, isPending: false },
  } as unknown as ReturnType<typeof useSprintMutations>);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SprintPanel projectId="p1" methodology={methodology} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateSprintMock.mockReset();
  window.localStorage.clear();
});

describe('SprintPanel', () => {
  it('renders nothing for WATERFALL projects', () => {
    const { container } = renderPanel({ methodology: 'WATERFALL' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no active sprint exists', () => {
    const { container } = renderPanel({ sprint: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the header band with goal and dates for an active sprint', () => {
    renderPanel({
      sprint: makeSprint({
        state: 'ACTIVE',
        short_id_display: 'SP-ABC',
        goal: 'Ship the burndown panel',
        start_date: '2026-04-01',
        finish_date: '2026-04-14',
      }),
    });
    expect(screen.getByText('SP-ABC')).toBeInTheDocument();
    expect(screen.getByText('Ship the burndown panel')).toBeInTheDocument();
    expect(screen.getByLabelText(/sprint panel/i)).toBeInTheDocument();
  });

  it('expands by default for SCHEDULER+ and renders body content', () => {
    renderPanel({ role: ROLE_SCHEDULER });
    expect(screen.getByTestId('burn-chart')).toBeVisible();
    expect(screen.getByRole('button', { name: /collapse sprint panel/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('collapses by default for VIEWER (body hidden from AT)', () => {
    renderPanel({ role: ROLE_VIEWER });
    // Body is always rendered (so aria-controls stays valid), but hidden.
    expect(screen.getByTestId('burn-chart')).not.toBeVisible();
    expect(screen.getByRole('button', { name: /expand sprint panel/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('persists collapsed-state to localStorage on toggle', () => {
    renderPanel({ role: ROLE_SCHEDULER });
    const toggle = screen.getByRole('button', { name: /collapse sprint panel/i });
    fireEvent.click(toggle);
    expect(window.localStorage.getItem('trueppm.board.p1.sprintPanel.open')).toBe('false');
    expect(screen.getByTestId('burn-chart')).not.toBeVisible();
  });

  it('SCHEDULER+ sees a "Set capacity" edit affordance when capacity_points is null', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: null }),
    });
    const btn = screen.getByRole('button', { name: /set planned story-point capacity/i });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent(/not set/i);
  });

  it('VIEWER sees capacity row as read-only', () => {
    renderPanel({
      role: ROLE_VIEWER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: 40 }),
    });
    // VIEWER collapses by default; expand panel to inspect the capacity card.
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    const editBtn = screen.queryByRole('button', { name: /edit planned story-point capacity/i });
    expect(editBtn).toBeNull();
  });

  it('saves capacity_points on Enter and clears editing state', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: null }),
    });
    fireEvent.click(screen.getByRole('button', { name: /set planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).toHaveBeenCalledWith({
      sprintId: 'sp-id',
      payload: { capacity_points: 42 },
    });
  });

  it('clears capacity_points to null when input emptied and committed', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: 40 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /edit planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateSprintMock).toHaveBeenCalledWith({
      sprintId: 'sp-id',
      payload: { capacity_points: null },
    });
  });

  it('reverts edit on Escape without saving', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: 30 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /edit planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateSprintMock).not.toHaveBeenCalled();
  });

  it('shows on-plan status when committed <= planned', () => {
    renderPanel({
      role: ROLE_MEMBER,
      sprint: makeSprint({
        state: 'ACTIVE',
        capacity_points: 50,
        committed_points: 42,
      }),
    });
    // MEMBER collapses by default — expand to see the body status text.
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    expect(screen.getByText(/on plan/i)).toBeInTheDocument();
  });

  it('shows critical status when committed exceeds planned by >10%', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({
        state: 'ACTIVE',
        capacity_points: 30,
        committed_points: 40,
      }),
    });
    expect(screen.getByText(/Over by 10 \(\+33%\)/i)).toBeInTheDocument();
  });
});

describe('SprintPanel WIP limit (#546)', () => {
  it('suppresses the WIP chip when wip_limit is null', () => {
    renderPanel({ sprint: makeSprint({ state: 'ACTIVE', wip_limit: null }) });
    expect(screen.queryByTestId('sprint-wip-chip')).toBeNull();
  });

  it('renders the WIP chip in neutral state when count is within the limit', () => {
    renderPanel({
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 3 }),
    });
    const chip = screen.getByTestId('sprint-wip-chip');
    expect(chip).toHaveTextContent('WIP 3/5');
    expect(chip).toHaveAttribute('aria-label', expect.stringMatching(/within limit/i));
    expect(chip.className).not.toMatch(/at-risk|critical/);
  });

  it('shows the WIP chip at-risk (amber) when count equals the limit', () => {
    renderPanel({
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 5 }),
    });
    const chip = screen.getByTestId('sprint-wip-chip');
    expect(chip).toHaveTextContent('WIP 5/5');
    expect(chip).toHaveAttribute('aria-label', expect.stringMatching(/at limit/i));
    expect(chip.className).toMatch(/at-risk/);
    expect(chip.className).not.toMatch(/critical/);
  });

  it('flips the WIP chip to critical (red) when count exceeds the limit', () => {
    renderPanel({
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 4, wip_count: 6 }),
    });
    const chip = screen.getByTestId('sprint-wip-chip');
    expect(chip).toHaveTextContent('WIP 6/4');
    expect(chip).toHaveAttribute('aria-label', expect.stringMatching(/over limit/i));
    expect(chip.className).toMatch(/critical/);
  });

  it('SCHEDULER+ can set a WIP limit and it saves wip_limit', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: null, wip_count: 2 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /set wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).toHaveBeenCalledWith({
      sprintId: 'sp-id',
      payload: { wip_limit: 5 },
    });
  });

  it('clears the WIP limit to null when the input is emptied', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 2 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /edit wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateSprintMock).toHaveBeenCalledWith({
      sprintId: 'sp-id',
      payload: { wip_limit: null },
    });
  });

  it('does not save a zero WIP limit (PositiveInteger floor)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: null, wip_count: 2 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /set wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).not.toHaveBeenCalled();
  });

  it('VIEWER sees the WIP limit read-only (no edit affordance)', () => {
    renderPanel({
      role: ROLE_VIEWER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 2 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    expect(screen.queryByRole('button', { name: /edit wip limit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /set wip limit/i })).toBeNull();
  });

  it('clicking the WIP chip expands a collapsed panel', () => {
    renderPanel({
      role: ROLE_VIEWER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 6 }),
    });
    // VIEWER collapses by default.
    expect(screen.getByTestId('burn-chart')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('sprint-wip-chip'));
    expect(screen.getByTestId('burn-chart')).toBeVisible();
  });
});

describe('SprintPanel velocity + forecast (#607)', () => {
  const SPRINTS = [
    { id: '1', name: 'S1', start_date: '2026-01-01', finish_date: '2026-01-14',
      committed_points: 30, completed_points: 24, committed_task_count: 6, completed_task_count: 5 },
    { id: '2', name: 'S2', start_date: '2026-01-15', finish_date: '2026-01-28',
      committed_points: 30, completed_points: 32, committed_task_count: 6, completed_task_count: 7 },
  ];

  it('renders the velocity sparkline and mounts the forecast line when not suppressed', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      velocity: { sprints: SPRINTS, rolling_avg_points: 28, rolling_stdev_points: 4 },
    });
    expect(screen.getByTestId('velocity-sparkline')).toBeInTheDocument();
    expect(screen.queryByTestId('velocity-suppressed')).toBeNull();
  });

  it('renders the team-private gated state when velocity is suppressed (ADR-0104)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      velocity: { sprints: [], velocity_suppressed: true },
    });
    expect(screen.getByTestId('velocity-suppressed')).toHaveTextContent(/team-private/i);
    // Neither the chart nor the forecast line render in the gated state.
    expect(screen.queryByTestId('velocity-sparkline')).toBeNull();
    expect(screen.queryByTestId('velocity-forecast-line')).toBeNull();
  });
});
