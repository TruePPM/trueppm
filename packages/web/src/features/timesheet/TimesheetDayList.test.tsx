import type { ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TimesheetDayList } from './TimesheetDayList';
import type { DayColumn, TimesheetRow } from './weekModel';

vi.mock('./AddTaskRow', () => ({ AddTaskRow: () => <div data-testid="add-task-row" /> }));

const DAY: DayColumn = {
  date: '2026-06-19',
  weekday: 4,
  isWeekend: false,
  isToday: true,
  isFuture: false,
};

const ROW: TimesheetRow = {
  taskId: 't1',
  taskShortId: 'RIV-1',
  taskName: 'Foundation pour',
  projectId: 'p1',
  projectCode: 'RIV',
  projectName: 'Riverside',
  cells: {},
};

function renderList(over: Partial<ComponentProps<typeof TimesheetDayList>> = {}) {
  const props = {
    rows: [ROW],
    day: DAY,
    dayTotal: 0,
    existingTaskIds: new Set(['t1']),
    submitted: false,
    cellErrors: {},
    onCellSave: vi.fn(),
    onAddTask: vi.fn(),
    ...over,
  };
  render(<TimesheetDayList {...props} />);
  return props;
}

describe('TimesheetDayList', () => {
  it('renders one labelled row per task with an hours field for the day', () => {
    renderList();
    const grid = screen.getByRole('grid', { name: 'Timesheet for Fri 19' });
    expect(within(grid).getByText('Foundation pour')).toBeInTheDocument();
    expect(within(grid).getByRole('textbox', { name: /Foundation pour, Fri 19/ })).toBeInTheDocument();
    expect(screen.getByTestId('add-task-row')).toBeInTheDocument();
  });

  it('flags a day total over 8 hours in its accessible name', () => {
    renderList({ dayTotal: 540 });
    expect(screen.getByLabelText('Fri 19 total 9:00, over 8 hours')).toBeInTheDocument();
  });

  it('hides add-task and makes cells read-only once the week is submitted', () => {
    renderList({ submitted: true });
    expect(screen.queryByTestId('add-task-row')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
