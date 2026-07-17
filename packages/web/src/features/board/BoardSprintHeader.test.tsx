import type { ReactNode } from 'react';
import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { BoardSprintHeader } from './BoardSprintHeader';
import type { ApiSprint } from '@/types';

// Stub Recharts ResponsiveContainer so the compact burndown renders in jsdom.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div style={{ width: 220, height: 64 }}>{children}</div>
    ),
  };
});

vi.mock('@/hooks/useSprints', () => ({
  useSprintBurndown: vi.fn(),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    singular: 'Sprint',
    plural: 'Sprints',
    possessive: "Sprint's",
  }),
}));

import { useSprintBurndown } from '@/hooks/useSprints';

const mockBurndown = vi.mocked(useSprintBurndown);
const asSB = (v: unknown) => v as ReturnType<typeof useSprintBurndown>;

function makeSprint(overrides: Partial<ApiSprint> = {}): ApiSprint {
  return {
    id: 'sp-1',
    server_version: 1,
    short_id: 'A1',
    short_id_display: 'SP-A1',
    name: 'Sprint 24',
    goal: 'Ship the planning bridge',
    notes: '',
    start_date: '2026-03-04',
    finish_date: '2026-03-17',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: 40,
    committed_task_count: 8,
    ...overrides,
  } as ApiSprint;
}

function mockSprintData(sprint: ApiSprint, snapshots: unknown[] = []) {
  mockBurndown.mockReturnValue(
    asSB({
      data: { sprint, snapshots },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // Mid-window so phase === 'during', Day 7 of 14.
  vi.setSystemTime(new Date('2026-03-10T12:00:00'));
  vi.clearAllMocks();
});

// Restore real timers so fake timers don't leak into the next file in the
// shared single-fork process (see src/test/setup.ts).
afterEach(() => {
  vi.useRealTimers();
});

describe('BoardSprintHeader (#1138)', () => {
  it('renders name, date range, and Day N of M counter as one accessible string', () => {
    const sprint = makeSprint();
    mockSprintData(sprint, [
      {
        id: 'sn',
        snapshot_date: '2026-03-10',
        remaining_points: 24,
        remaining_task_count: 5,
        completed_points: 16,
        completed_task_count: 3,
        scope_change_points: 0,
        scope_change_task_count: 0,
        created_at: '2026-03-10T00:00:00Z',
      },
    ]);
    renderWithProviders(<BoardSprintHeader sprint={sprint} projectId="p-1" />);

    expect(screen.getByText('Sprint 24')).toBeInTheDocument();
    // Single accessible meta string with name, range, and Day-of counter.
    expect(screen.getByLabelText(/Sprint 24.*Day 7 of 14/)).toBeInTheDocument();
  });

  it('renders the goal line with the full text in title + aria-label', () => {
    const sprint = makeSprint({ goal: 'Ship the planning bridge' });
    mockSprintData(sprint);
    renderWithProviders(<BoardSprintHeader sprint={sprint} projectId="p-1" />);
    const goal = screen.getByLabelText('Ship the planning bridge');
    expect(goal).toHaveAttribute('title', 'Ship the planning bridge');
    expect(goal).toHaveClass('truncate');
  });

  it('omits the goal line entirely when goal is empty', () => {
    const sprint = makeSprint({ goal: '' });
    mockSprintData(sprint);
    renderWithProviders(<BoardSprintHeader sprint={sprint} projectId="p-1" />);
    // The goal line (TargetIcon + text) is gated on a non-empty goal.
    expect(screen.queryByTestId('sprint-goal')).toBeNull();
  });

  it('PLANNED future sprint shows the not-started caption', () => {
    const sprint = makeSprint({
      state: 'PLANNED',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
      committed_points: 40,
    });
    mockSprintData(sprint, []); // no snapshots -> flat baseline
    renderWithProviders(<BoardSprintHeader sprint={sprint} projectId="p-1" />);
    expect(screen.getByText(/Not started/)).toBeInTheDocument();
    expect(screen.getByText(/committed/)).toBeInTheDocument();
  });

  it('COMPLETED sprint shows the closed caption', () => {
    const sprint = makeSprint({
      state: 'COMPLETED',
      start_date: '2026-02-01',
      finish_date: '2026-02-14',
    });
    mockSprintData(sprint, [
      {
        id: 'sn',
        snapshot_date: '2026-02-14',
        remaining_points: 0,
        remaining_task_count: 0,
        completed_points: 40,
        completed_task_count: 8,
        scope_change_points: 0,
        scope_change_task_count: 0,
        created_at: '2026-02-14T00:00:00Z',
      },
    ]);
    renderWithProviders(<BoardSprintHeader sprint={sprint} projectId="p-1" />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
    // After-phase counter reads "Completed {finish}".
    expect(screen.getByLabelText(/Completed/)).toBeInTheDocument();
  });
});
