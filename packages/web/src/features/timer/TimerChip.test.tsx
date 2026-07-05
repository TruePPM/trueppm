import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TimerChip } from './TimerChip';
import type { ActiveTimer } from '@/hooks/useActiveTimer';

// Mock the hook boundary: the live-tick + query behavior is exercised in
// useActiveTimer.test.ts; here we assert TimerChip's rendering given hook output.
const { stopTimerSpy, hookState } = vi.hoisted(() => ({
  stopTimerSpy: vi.fn(),
  hookState: { timer: null as ActiveTimer | null, elapsed: 0, isStopping: false },
}));
vi.mock('@/hooks/useActiveTimer', () => ({
  useActiveTimer: () => ({ timer: hookState.timer, stopTimer: stopTimerSpy, isStopping: hookState.isStopping }),
  useElapsedSeconds: () => hookState.elapsed,
}));

const RUNNING: ActiveTimer = {
  id: 'timer-1',
  task: 'task-a',
  task_short_id: 'RIV-01',
  task_name: 'Foundation pour',
  project: 'proj-1',
  started_at: '2026-07-05T10:00:00Z',
  elapsed_seconds: 5046,
  note: '',
  stale: false,
};

describe('TimerChip', () => {
  beforeEach(() => {
    stopTimerSpy.mockClear();
    hookState.timer = null;
    hookState.elapsed = 0;
    hookState.isStopping = false;
  });

  it('renders nothing when no timer is running', () => {
    const { container } = render(<TimerChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the live elapsed clock, task label, and a stop control while running', () => {
    hookState.timer = RUNNING;
    hookState.elapsed = 5046; // 1:24:06
    render(<TimerChip />);

    expect(screen.getByText('1:24:06')).toBeInTheDocument();
    expect(screen.getByText('RIV-01 · Foundation pour')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Stop timer and log time on RIV-01 · Foundation pour' }),
    ).toBeInTheDocument();
    // The live-region name is stable (event-driven), not the ticking clock.
    expect(
      screen.getByRole('status', { name: 'Timer running on RIV-01 · Foundation pour' }),
    ).toBeInTheDocument();
  });

  it('reflects the elapsed value it is given (derived from started_at)', () => {
    hookState.timer = RUNNING;
    hookState.elapsed = 5047;
    render(<TimerChip />);
    expect(screen.getByText('1:24:07')).toBeInTheDocument();
  });

  it('announces the stale state when the timer has run too long', () => {
    hookState.timer = { ...RUNNING, stale: true };
    hookState.elapsed = 40000;
    render(<TimerChip />);
    expect(screen.getByRole('status', { name: /running a long time/ })).toBeInTheDocument();
  });

  it('stops the timer when the stop control is clicked', () => {
    hookState.timer = RUNNING;
    hookState.elapsed = 5046;
    render(<TimerChip />);
    fireEvent.click(screen.getByRole('button', { name: /Stop timer and log time/ }));
    expect(stopTimerSpy).toHaveBeenCalledTimes(1);
  });
});
