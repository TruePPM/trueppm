import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SprintPanel } from './SprintPanel';
import { makeSprint } from '@/features/sprints/sprintTestFixtures';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_VIEWER } from '@/lib/roles';
import type { ApiSprint } from '@/types';

const updateSprintMock = vi.fn();

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: toastErrorMock } }));

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
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: vi.fn(),
}));
vi.mock('@/features/reports/BurnChart', () => ({
  BurnChart: ({ sprintId }: { sprintId: string }) => (
    <div data-testid="burn-chart">burn-chart:{sprintId}</div>
  ),
}));
// Stub the promote dialog so the entry-point test asserts open/close without
// mounting the dialog's own API hooks (candidates / reforecast preview).
vi.mock('@/features/sprints/PromoteMilestoneDialog', () => ({
  PromoteMilestoneDialog: ({ sprint, onClose }: { sprint: ApiSprint; onClose: () => void }) => (
    <div role="dialog" aria-label="Promote dialog stub">
      promote:{sprint.id}
      <button type="button" onClick={onClose}>
        close stub
      </button>
    </div>
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
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import type { Task } from '@/types';

const useCurrentUserRoleMock = vi.mocked(useCurrentUserRole);
const useActiveSprintMock = vi.mocked(useActiveSprint);
const useProjectVelocityMock = vi.mocked(useProjectVelocity);
const useProjectForecastMock = vi.mocked(useProjectForecast);
const useSprintMutationsMock = vi.mocked(useSprintMutations);
const useScheduleTasksMock = vi.mocked(useScheduleTasks);

/** Minimal task for the critical-path count filter (sprintId/isCritical/plannedStart/isComplete). */
function makeTask(over: Partial<Task>): Task {
  return {
    id: 'task-x',
    sprintId: null,
    isCritical: false,
    isComplete: false,
    plannedStart: '2026-06-01',
    ...over,
  } as unknown as Task;
}

function renderPanel(opts: {
  methodology?: 'WATERFALL' | 'AGILE' | 'HYBRID' | undefined;
  boardCadence?: 'sprint' | 'continuous';
  sprint?: ApiSprint | null;
  role?: number | null;
  velocity?: Partial<ProjectVelocity>;
  tasks?: Task[];
} = {}) {
  const {
    methodology = 'AGILE',
    boardCadence = 'sprint',
    sprint = makeSprint({ state: 'ACTIVE' }),
    role = ROLE_SCHEDULER,
    velocity,
    tasks = [],
  } = opts;
  useActiveSprintMock.mockReturnValue({ sprint, isLoading: false });
  useScheduleTasksMock.mockReturnValue({ tasks } as unknown as ReturnType<typeof useScheduleTasks>);
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
      <SprintPanel projectId="p1" methodology={methodology} boardCadence={boardCadence} />
    </QueryClientProvider>,
  );
}

/**
 * The panel now collapses by default for every role (#1983), so any test that
 * inspects body content (velocity/capacity/WIP cards) must expand it first.
 */
function expandPanel() {
  fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
}

beforeEach(() => {
  updateSprintMock.mockReset();
  toastErrorMock.mockReset();
  window.localStorage.clear();
});

describe('SprintPanel', () => {
  it('shows the critical-path count for scheduled, incomplete critical tasks in the sprint (#549)', () => {
    const sprint = makeSprint({ state: 'ACTIVE', id: 'sp-1' });
    renderPanel({
      sprint,
      tasks: [
        makeTask({ id: 't1', sprintId: 'sp-1', isCritical: true }),
        makeTask({ id: 't2', sprintId: 'sp-1', isCritical: true }),
        makeTask({ id: 't3', sprintId: 'sp-1', isCritical: false }), // not critical
        makeTask({ id: 't4', sprintId: 'sp-1', isCritical: true, isComplete: true }), // complete
        makeTask({ id: 't5', sprintId: 'other', isCritical: true }), // other sprint
      ],
    });
    expect(screen.getByLabelText('2 tasks on the critical path')).toBeInTheDocument();
  });

  it('omits the critical-path count when no in-sprint critical work remains (#549)', () => {
    const sprint = makeSprint({ state: 'ACTIVE', id: 'sp-1' });
    renderPanel({ sprint, tasks: [makeTask({ id: 't1', sprintId: 'sp-1', isCritical: false })] });
    expect(screen.queryByText(/on critical path/i)).not.toBeInTheDocument();
  });

  it('renders nothing for WATERFALL projects', () => {
    const { container } = renderPanel({ methodology: 'WATERFALL' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a continuous-flow Kanban board, even with an active sprint (#410)', () => {
    const { container } = renderPanel({ boardCadence: 'continuous' });
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

  it('collapses by default for SCHEDULER+ so the board stays above the fold (#1983)', () => {
    renderPanel({ role: ROLE_SCHEDULER });
    // Body content (the burndown disclosure toggle) is rendered but hidden.
    expect(screen.getByTestId('sprint-burndown-toggle')).not.toBeVisible();
    expect(screen.getByRole('button', { name: /expand sprint panel/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('collapses by default for VIEWER (body hidden from AT)', () => {
    renderPanel({ role: ROLE_VIEWER });
    // Body is always rendered (so aria-controls stays valid), but hidden.
    expect(screen.getByTestId('sprint-burndown-toggle')).not.toBeVisible();
    expect(screen.getByRole('button', { name: /expand sprint panel/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('persists expanded-state to localStorage on toggle', () => {
    renderPanel({ role: ROLE_SCHEDULER });
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    expect(window.localStorage.getItem('trueppm.board.p1.sprintPanel.open')).toBe('true');
    expect(screen.getByTestId('sprint-burndown-toggle')).toBeVisible();
  });

  it('reveals the burndown only when its pull-on-demand disclosure is opened (#1983)', () => {
    renderPanel({ role: ROLE_SCHEDULER });
    expandPanel();
    // The panel body is open, but the burndown chart is not rendered until the
    // disclosure is expanded — the board never pays for the chart on load.
    expect(screen.queryByTestId('burn-chart')).toBeNull();
    fireEvent.click(screen.getByTestId('sprint-burndown-toggle'));
    expect(screen.getByTestId('burn-chart')).toBeVisible();
  });

  it('SCHEDULER+ sees a "Set capacity" edit affordance when capacity_points is null', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: null }),
    });
    expandPanel();
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
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /set planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).toHaveBeenCalledWith(
      { sprintId: 'sp-id', payload: { capacity_points: 42 } },
      expect.anything(),
    );
  });

  it('clears capacity_points to null when input emptied and committed', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: 40 }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /edit planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateSprintMock).toHaveBeenCalledWith(
      { sprintId: 'sp-id', payload: { capacity_points: null } },
      expect.anything(),
    );
  });

  it('toasts when a capacity save fails (#2150 — no optimistic UI otherwise)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: null }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /set planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Drive the onError the component passed to updateSprint.mutate.
    const opts = updateSprintMock.mock.calls[0][1] as { onError: () => void };
    opts.onError();
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't save the sprint capacity — try again.");
  });

  it('reverts edit on Escape without saving', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: 30 }),
    });
    expandPanel();
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
    expandPanel();
    expect(screen.getByText(/Over by 10 \(\+33%\)/i)).toBeInTheDocument();
  });
});

describe('SprintPanel promote-to-milestone entry point (#1052)', () => {
  it('SCHEDULER+ sees "Link to milestone" when the active sprint has no bound milestone', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', target_milestone: null }),
    });
    expect(screen.getByRole('button', { name: /link to milestone/i })).toBeInTheDocument();
  });

  it('hides "Link to milestone" once a milestone is bound (rebind lives in the dialog/Sprints view)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', target_milestone: 'm-1' }),
    });
    expect(screen.queryByRole('button', { name: /link to milestone/i })).toBeNull();
  });

  it('does not show "Link to milestone" for MEMBER (schedule-authoring gate)', () => {
    renderPanel({
      role: ROLE_MEMBER,
      sprint: makeSprint({ state: 'ACTIVE', target_milestone: null }),
    });
    expect(screen.queryByRole('button', { name: /link to milestone/i })).toBeNull();
  });

  it('opens the promote dialog when "Link to milestone" is clicked', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', target_milestone: null }),
    });
    expect(screen.queryByRole('dialog', { name: /promote dialog stub/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /link to milestone/i }));
    expect(screen.getByRole('dialog', { name: /promote dialog stub/i })).toBeInTheDocument();
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
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /set wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).toHaveBeenCalledWith(
      { sprintId: 'sp-id', payload: { wip_limit: 5 } },
      expect.anything(),
    );
  });

  it('clears the WIP limit to null when the input is emptied', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 2 }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /edit wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateSprintMock).toHaveBeenCalledWith(
      { sprintId: 'sp-id', payload: { wip_limit: null } },
      expect.anything(),
    );
  });

  it('does not save a zero WIP limit (PositiveInteger floor)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: null, wip_count: 2 }),
    });
    expandPanel();
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
    // Collapsed by default (#1983) — body content is hidden until expanded.
    expect(screen.getByTestId('sprint-burndown-toggle')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('sprint-wip-chip'));
    expect(screen.getByTestId('sprint-burndown-toggle')).toBeVisible();
  });
});

describe('SprintPanel persisted expand state', () => {
  it('restores a stored expanded state on mount (opens already-expanded)', () => {
    window.localStorage.setItem('trueppm.board.p1.sprintPanel.open', 'true');
    renderPanel({ role: ROLE_SCHEDULER });
    expect(screen.getByRole('button', { name: /collapse sprint panel/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('sprint-burndown-toggle')).toBeVisible();
  });

  it('persists collapse back to localStorage when an expanded panel is toggled shut', () => {
    window.localStorage.setItem('trueppm.board.p1.sprintPanel.open', 'true');
    renderPanel({ role: ROLE_SCHEDULER });
    fireEvent.click(screen.getByRole('button', { name: /collapse sprint panel/i }));
    expect(window.localStorage.getItem('trueppm.board.p1.sprintPanel.open')).toBe('false');
    expect(screen.getByTestId('sprint-burndown-toggle')).not.toBeVisible();
  });
});

describe('SprintPanel header signals', () => {
  it('shows committed points and the pending-acceptance forecast caption', () => {
    renderPanel({
      sprint: makeSprint({
        state: 'ACTIVE',
        committed_points: 42,
        pending_count: 3,
      }),
    });
    expect(screen.getByText(/42 pts committed/i)).toBeInTheDocument();
    expect(screen.getByText(/3 pending acceptance/i)).toBeInTheDocument();
  });

  it('omits the pending caption when nothing is pending acceptance', () => {
    renderPanel({
      sprint: makeSprint({ state: 'ACTIVE', committed_points: 42, pending_count: 0 }),
    });
    expect(screen.queryByText(/pending acceptance/i)).not.toBeInTheDocument();
  });
});

describe('SprintPanel capacity edge branches', () => {
  it('shows the at-risk band when committed exceeds planned by <=10%', () => {
    renderPanel({
      role: ROLE_MEMBER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: 30, committed_points: 33 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    // 3 over / 30 planned = +10% → at-risk (amber), still an "Over by" message.
    expect(screen.getByText(/Over by 3 \(\+10%\)/i)).toBeInTheDocument();
  });

  it('rejects a non-integer capacity draft (no save, editing closes)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: null }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /set planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '3.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).not.toHaveBeenCalled();
    // Editing state cleared even though nothing saved.
    expect(screen.getByRole('button', { name: /set planned story-point capacity/i })).toBeInTheDocument();
  });

  it('rejects a negative capacity draft', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', capacity_points: null }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /set planned story-point capacity/i }));
    const input = screen.getByLabelText(/planned story-point capacity/i);
    fireEvent.change(input, { target: { value: '-4' } });
    fireEvent.blur(input);
    expect(updateSprintMock).not.toHaveBeenCalled();
  });
});

describe('SprintPanel WIP card body warnings (#546)', () => {
  it('renders the "At WIP limit" body warning when count equals the limit', () => {
    renderPanel({
      role: ROLE_MEMBER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 5 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    expect(screen.getByText('At WIP limit')).toBeInTheDocument();
  });

  it('renders the "Over WIP by N" body warning when count exceeds the limit', () => {
    renderPanel({
      role: ROLE_MEMBER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 4, wip_count: 6 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /expand sprint panel/i }));
    expect(screen.getByText(/Over WIP by 2/)).toBeInTheDocument();
  });

  it('rejects a non-integer WIP draft', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: null, wip_count: 1 }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /set wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSprintMock).not.toHaveBeenCalled();
  });

  it('reverts a WIP edit on Escape without saving', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      sprint: makeSprint({ state: 'ACTIVE', wip_limit: 5, wip_count: 2 }),
    });
    expandPanel();
    fireEvent.click(screen.getByRole('button', { name: /edit wip limit/i }));
    const input = screen.getByLabelText(/wip limit/i);
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateSprintMock).not.toHaveBeenCalled();
  });
});

describe('SprintPanel burndown disclosure persistence (#1983)', () => {
  it('mounts the burndown chart on load when its disclosure was previously opened', () => {
    window.localStorage.setItem('trueppm.board.p1.sprintPanel.open.burndown', 'true');
    renderPanel({ role: ROLE_SCHEDULER });
    expandPanel();
    // Disclosure restored open → chart mounts without a second click.
    expect(screen.getByTestId('burn-chart')).toBeVisible();
    expect(screen.getByTestId('sprint-burndown-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('persists the burndown disclosure open state to its own storage key', () => {
    renderPanel({ role: ROLE_SCHEDULER });
    expandPanel();
    fireEvent.click(screen.getByTestId('sprint-burndown-toggle'));
    expect(window.localStorage.getItem('trueppm.board.p1.sprintPanel.open.burndown')).toBe('true');
  });
});

describe('SprintPanel velocity + forecast (#607)', () => {
  const SPRINTS = [
    { id: '1', name: 'S1', start_date: '2026-01-01', finish_date: '2026-01-14',
      committed_points: 30, completed_points: 24, committed_task_count: 6, completed_task_count: 5,
      exclude_from_velocity: false },
    { id: '2', name: 'S2', start_date: '2026-01-15', finish_date: '2026-01-28',
      committed_points: 30, completed_points: 32, committed_task_count: 6, completed_task_count: 7,
      exclude_from_velocity: false },
  ];

  it('renders the velocity sparkline and mounts the forecast line when not suppressed', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      velocity: { sprints: SPRINTS, rolling_avg_points: 28, rolling_stdev_points: 4 },
    });
    expandPanel();
    expect(screen.getByTestId('velocity-sparkline')).toBeInTheDocument();
    expect(screen.queryByTestId('velocity-suppressed')).toBeNull();
  });

  it('renders the team-private gated state when velocity is suppressed (ADR-0104)', () => {
    renderPanel({
      role: ROLE_SCHEDULER,
      velocity: { sprints: [], velocity_suppressed: true },
    });
    expandPanel();
    expect(screen.getByTestId('velocity-suppressed')).toHaveTextContent(/team-private/i);
    // Neither the chart nor the forecast line render in the gated state.
    expect(screen.queryByTestId('velocity-sparkline')).toBeNull();
    expect(screen.queryByTestId('velocity-forecast-line')).toBeNull();
  });
});
