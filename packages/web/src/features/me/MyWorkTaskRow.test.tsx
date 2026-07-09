import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import type { MyWorkTask } from '@/hooks/useMyWork';

// Spy on the warm toast + stub the optimistic status mutation so the complete
// flow is deterministic (no network): mutate() invokes its onSuccess synchronously.
const { warmSpy, mutateSpy } = vi.hoisted(() => ({
  warmSpy: vi.fn(),
  mutateSpy: vi.fn((_args: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
}));
vi.mock('@/components/Toast', () => ({
  toast: { warm: warmSpy, info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/useMyWork', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useMyWork')>()),
  useMyWorkStatusUpdate: () => ({ mutate: mutateSpy, isPending: false }),
}));

// Hermetic timer: no /me/timer/ network from the row's TaskTimerControl (#1415).
// `runningTaskId` drives which task is treated as running; the elapsed ticker is
// stubbed to a fixed value so the running-row assertion is deterministic.
const { startTimerSpy, stopTimerSpy, timerState } = vi.hoisted(() => ({
  startTimerSpy: vi.fn(),
  stopTimerSpy: vi.fn(),
  timerState: { runningTaskId: null as string | null },
}));
vi.mock('@/hooks/useActiveTimer', () => ({
  useActiveTimer: () => ({
    timer: timerState.runningTaskId
      ? { task: timerState.runningTaskId, started_at: '2026-07-05T10:00:00Z' }
      : null,
    startTimer: startTimerSpy,
    stopTimer: stopTimerSpy,
    isTaskRunning: (id: string) => timerState.runningTaskId === id,
    isStarting: false,
    isStopping: false,
  }),
  useElapsedSeconds: (startedAt: string | null | undefined) => (startedAt ? 5046 : 0),
}));

// Time-entry rollup + write hooks stubbed so the row's logged-today chip and the
// LogTimePopover (#1234) render without network. `loggedTodayMinutes` drives the chip.
const { timeState, createMutate } = vi.hoisted(() => ({
  timeState: { loggedTodayMinutes: 0 },
  createMutate: vi.fn(),
}));
vi.mock('@/hooks/useTimeEntry', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useTimeEntry')>()),
  useTimeRollup: () => ({
    todayMinutes: timeState.loggedTodayMinutes,
    weekMinutes: timeState.loggedTodayMinutes,
    loggedTodayForTask: () => timeState.loggedTodayMinutes,
  }),
  useCreateTimeEntry: () => ({ mutate: createMutate, isPending: false }),
  useDeleteTimeEntry: () => ({ mutate: vi.fn(), isPending: false }),
}));

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ul>{ui}</ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BASE: MyWorkTask = {
  id: 't1',
  short_id: 'PRJ-01',
  name: 'Build login',
  project_id: 'p1',
  project_name: 'App',
  program_id: 'prog1',
  program_name: 'Apollo Program',
  program_color: '#3366cc',
  sprint_id: null,
  sprint_name: null,
  status: 'IN_PROGRESS',
  story_points: null,
  remaining_points: null,
  due: null,
  due_source: 'planned',
  is_critical: false,
  group: 'today',
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 1,
  url: '/projects/p1/schedule?task=t1',
};

describe('MyWorkTaskRow blocker badge (ADR-0124 #1135)', () => {
  it('renders no blocker badge when not blocked', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('renders the type chip and age badge when blocked with a type', () => {
    wrap(
      <MyWorkTaskRow
        task={{
          ...BASE,
          is_blocked: true,
          blocked_reason: 'waiting on legal',
          blocker_type: 'vendor',
          blocked_age_seconds: 93600, // 1d 2h
        }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('External vendor')).toBeInTheDocument();
    expect(screen.getByText('1d 2h blocked')).toBeInTheDocument();
    // My Work is the assignee's own surface, so the reason renders here.
    expect(screen.getByText('waiting on legal')).toBeInTheDocument();
  });

  it('omits the type chip when blocked with no structured type (paused)', () => {
    wrap(
      <MyWorkTaskRow
        task={{
          ...BASE,
          is_blocked: true,
          blocked_reason: 'just stuck',
          blocker_type: '',
          blocked_age_seconds: 3600,
        }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.queryByText('External vendor')).not.toBeInTheDocument();
    expect(screen.getByText('1h blocked')).toBeInTheDocument();
  });
});

describe('MyWorkTaskRow quick-log time (#1234)', () => {
  beforeEach(() => {
    timeState.loggedTodayMinutes = 0;
    createMutate.mockClear();
  });

  it('exposes a "Log time" action that opens the quick-log popover', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    const trigger = screen.getByRole('button', { name: 'Log time on Build login' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: /Log time · PRJ-01/ })).toBeInTheDocument();
  });

  it('renders the logged-today chip only when time is logged', () => {
    const { rerender } = wrap(<MyWorkTaskRow task={BASE} />);
    expect(screen.queryByLabelText(/logged today/)).not.toBeInTheDocument();

    timeState.loggedTodayMinutes = 90;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ul>
            <MyWorkTaskRow task={BASE} />
          </ul>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('1:30 logged today')).toBeInTheDocument();
  });
});

describe('MyWorkTaskRow complete checkbox (#1226)', () => {
  beforeEach(() => {
    warmSpy.mockClear();
    mutateSpy.mockClear();
  });

  it('renders a "Mark complete" checkbox for an incomplete task', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    expect(screen.getByRole('button', { name: 'Mark Build login complete' })).toBeInTheDocument();
  });

  it('completing requests COMPLETE, plays the checkpop spring, and fires the warm toast (rule 184)', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    const checkbox = screen.getByRole('button', { name: 'Mark Build login complete' });
    fireEvent.click(checkbox);
    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', next: 'COMPLETE' }),
      expect.anything(),
    );
    expect(warmSpy).toHaveBeenCalledWith('Nice — Build login done.');
    // the check box plays the one-shot spring (cleared on animationend)
    expect(checkbox.querySelector('span')?.className).toContain('motion-safe:animate-checkpop');
  });

  it('shows a checked, non-interactive checkbox for an already-complete task', () => {
    wrap(<MyWorkTaskRow task={{ ...BASE, status: 'COMPLETE' }} />);
    const checkbox = screen.getByRole('button', { name: 'Build login is complete' });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute('aria-pressed', 'true');
    expect(warmSpy).not.toHaveBeenCalled();
  });
});

describe('MyWorkTaskRow timer control (#1415)', () => {
  beforeEach(() => {
    startTimerSpy.mockClear();
    stopTimerSpy.mockClear();
    timerState.runningTaskId = null;
  });

  it('renders a Start timer control that starts the timer on this task', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    const start = screen.getByRole('button', { name: 'Start timer on Build login' });
    fireEvent.click(start);
    expect(startTimerSpy).toHaveBeenCalledWith('t1');
  });

  it('shows a Stop control with the live inline elapsed when this task is running', () => {
    timerState.runningTaskId = 't1';
    wrap(<MyWorkTaskRow task={BASE} />);
    // No play control while running.
    expect(screen.queryByRole('button', { name: 'Start timer on Build login' })).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop timer on Build login and log time' });
    expect(stop).toBeInTheDocument();
    // 5046s → 1:24:06 inline elapsed.
    expect(screen.getByText('1:24:06')).toBeInTheDocument();
    fireEvent.click(stop);
    expect(stopTimerSpy).toHaveBeenCalled();
  });

  it('disables the Start control on a completed task', () => {
    wrap(<MyWorkTaskRow task={{ ...BASE, status: 'COMPLETE' }} />);
    expect(screen.getByRole('button', { name: 'Start timer on Build login' })).toBeDisabled();
  });
});

describe('MyWorkTaskRow phase exclusion (issue #1754, ADR-0293)', () => {
  it('renders nothing for a phase row (defense-in-depth — MyWorkPage already filters upstream)', () => {
    const { container } = wrap(<MyWorkTaskRow task={{ ...BASE, is_phase: true }} />);
    expect(container.querySelector('li')).toBeNull();
    expect(screen.queryByText('Build login')).not.toBeInTheDocument();
  });

  it('renders normally when is_phase is absent (legacy payload, #1753 not yet deployed)', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    expect(screen.getByText('Build login')).toBeInTheDocument();
  });
});

describe('MyWorkTaskRow program identity (#964)', () => {
  it('renders the program name as the accessible signal', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    // The program NAME is the a11y signal — the square itself is aria-hidden.
    expect(screen.getByText('Apollo Program')).toBeInTheDocument();
  });

  it('renders a decorative (aria-hidden) identity square carrying the accent color', () => {
    const { container } = wrap(<MyWorkTaskRow task={BASE} />);
    const square = container.querySelector('span[aria-hidden="true"][style]');
    expect(square).not.toBeNull();
    // Dynamic accent flows through the style prop (never a hex class).
    expect(square).toHaveStyle({ backgroundColor: '#3366cc' });
  });

  it('renders the neutral unset square and no name for an orphan project (no program)', () => {
    wrap(
      <MyWorkTaskRow
        task={{ ...BASE, program_id: null, program_name: null, program_color: null }}
      />,
    );
    // No program name text when the project has no program.
    expect(screen.queryByText('Apollo Program')).not.toBeInTheDocument();
    // The neutral square still renders (faint filled square, no inline color).
    const square = document.querySelector('span[aria-hidden="true"].bg-neutral-surface-sunken');
    expect(square).not.toBeNull();
  });
});
