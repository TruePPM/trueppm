import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Task } from '@/types';
import { CalendarGrid } from './CalendarGrid';

// useBreakpoint drives the desktop-grid vs mobile-list branch (#2161). Default
// to the reference desktop tier; the mobile test overrides it per-case.
const { breakpointMock } = vi.hoisted(() => ({ breakpointMock: vi.fn(() => 'lg') }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => breakpointMock() }));

afterEach(() => {
  breakpointMock.mockReturnValue('lg');
});

// Anchor to a fixed month so tests are deterministic
const ANCHOR = '2026-05-01'; // May 2026 — starts on Friday

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't1', wbs: '1', name: 'Integration Test', start: '2026-05-05', finish: '2026-05-08',
  duration: 4, progress: 0, parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
  ...overrides,
});

const milestoneTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'm1', wbs: '2', name: 'Launch Milestone', start: '2026-05-07', finish: '2026-05-07',
  duration: 0, progress: 0, parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: true,
  status: 'NOT_STARTED', assignees: [], notes: '',
  ...overrides,
});

describe('CalendarGrid', () => {
  it('renders day-of-week headers', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Fri')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
  });

  it('renders the CalendarLegend with all entries incl. Due + Sprint boundary (issue 1230)', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    expect(screen.getByText('At risk')).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('Milestone')).toBeInTheDocument();
    expect(screen.getByText('Due')).toBeInTheDocument();
    expect(screen.getByText('Sprint boundary')).toBeInTheDocument();
  });

  it('marks sprint start/finish days with a boundary dot (issue 1230)', () => {
    const boundaries = new Set(['2026-05-04', '2026-05-15']);
    render(
      <CalendarGrid
        anchorIso={ANCHOR}
        tasks={[]}
        onTaskClick={vi.fn()}
        sprintBoundaries={boundaries}
      />,
    );
    // One dot per boundary day that falls inside the rendered month grid.
    const dots = screen.getAllByLabelText('Sprint boundary');
    // Both boundary dates are in May 2026; the legend swatch is aria-hidden, so
    // only the day-cell dots carry the accessible label.
    expect(dots.length).toBe(2);
  });

  it('renders no boundary dots when no sprint boundaries are supplied', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.queryByLabelText('Sprint boundary')).not.toBeInTheDocument();
  });

  it('renders milestone as a ◆ diamond button, not a chip', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[milestoneTask()]} onTaskClick={vi.fn()} />);
    // The diamond SVG has a polygon element, and there is an aria-label for the milestone button
    const milestoneBtn = screen.getByRole('button', { name: /Milestone: Launch Milestone/i });
    expect(milestoneBtn).toBeInTheDocument();
    // The button contains a polygon (diamond SVG)
    const polygon = milestoneBtn.querySelector('polygon');
    expect(polygon).toBeInTheDocument();
    expect(polygon?.getAttribute('points')).toBe('5,0 10,5 5,10 0,5');
  });

  it('fires onTaskClick when milestone diamond is clicked', async () => {
    const onTaskClick = vi.fn();
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[milestoneTask()]} onTaskClick={onTaskClick} />);
    await userEvent.click(screen.getByRole('button', { name: /Milestone: Launch Milestone/i }));
    expect(onTaskClick).toHaveBeenCalledWith('m1');
  });

  it('duration tasks are not rendered as milestone diamonds', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    // No milestone button for a regular task
    expect(screen.queryByRole('button', { name: /Milestone:/i })).not.toBeInTheDocument();
  });

  it('renders chip for duration task (chip overlay present)', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    // CalendarChip renders a button with the task name
    const chipBtn = screen.getByRole('button', { name: /Integration Test/i });
    expect(chipBtn).toBeInTheDocument();
  });

  it('appends ", due" to the finish fragment of a task chip (issue 1230)', () => {
    // A single-week task's fragment contains its finish date → the due marker.
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Integration Test, due' }),
    ).toBeInTheDocument();
  });

  it('shows +N more overflow badge when too many chips in a week', () => {
    // Create 5 overlapping tasks in the same week to exceed MAX_LANES (4)
    const tasks = Array.from({ length: 5 }, (_, i) =>
      baseTask({ id: `t${i}`, wbs: `1.${i}`, name: `Task ${i}`, start: '2026-05-04', finish: '2026-05-08' }),
    );
    render(<CalendarGrid anchorIso={ANCHOR} tasks={tasks} onTaskClick={vi.fn()} />);
    expect(screen.getByText(/\+1 more/i)).toBeInTheDocument();
  });

  it('does not show overflow badge with 4 or fewer overlapping tasks', () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      baseTask({ id: `t${i}`, wbs: `1.${i}`, name: `Task ${i}`, start: '2026-05-04', finish: '2026-05-08' }),
    );
    render(<CalendarGrid anchorIso={ANCHOR} tasks={tasks} onTaskClick={vi.fn()} />);
    expect(screen.queryByText(/more/i)).not.toBeInTheDocument();
  });

  it('renders day numbers for the month', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    // May has 31 days — spot-check a few
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
  });

  it('renders the mobile date-grouped list (not the 7-col grid) under the sm breakpoint (#2161)', () => {
    breakpointMock.mockReturnValue('sm');
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    // Day-of-week header columns are grid-only — absent on mobile.
    expect(screen.queryByText('Wed')).not.toBeInTheDocument();
    // The task surfaces as a full-width row button instead.
    expect(screen.getByRole('button', { name: /Integration Test/ })).toBeInTheDocument();
    // The legend is retained on mobile.
    expect(screen.getByText('Critical path')).toBeInTheDocument();
  });
});
