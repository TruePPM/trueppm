import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimesheetGrid } from './TimesheetGrid';
import {
  buildRows,
  dailyTotals,
  weekDays,
  weekTotalMinutes,
  type WeeklyEntry,
} from './weekModel';

vi.mock('@/hooks/useMyWork', () => ({
  useMyWork: vi.fn(() => ({ data: { pages: [{ results: [] }] }, isLoading: false })),
}));

const MONDAY = '2026-06-15';

function entry(over: Partial<WeeklyEntry> = {}): WeeklyEntry {
  return {
    id: 'e1',
    task: 't1',
    task_short_id: 'ENG-1',
    task_name: 'Build the grid',
    project: 'p1',
    project_code: 'WEB',
    project_name: 'Web',
    minutes: 540,
    entry_date: MONDAY,
    note: '',
    source: 'manual',
    server_version: 1,
    created_at: '2026-06-15T09:00:00Z',
    ...over,
  };
}

function renderGrid(
  overrides: Partial<Parameters<typeof TimesheetGrid>[0]> = {},
  entries: WeeklyEntry[] = [entry()],
) {
  const rows = buildRows(entries);
  const days = weekDays(MONDAY, MONDAY);
  const props = {
    rows,
    days,
    dayTotals: dailyTotals(rows, days),
    weekTotal: weekTotalMinutes(rows),
    existingTaskIds: new Set(rows.map((r) => r.taskId)),
    submitted: false,
    cellErrors: {},
    onCellSave: vi.fn(),
    onAddTask: vi.fn(),
    ...overrides,
  };
  render(<TimesheetGrid {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TimesheetGrid', () => {
  it('renders the grid, the task row, and the week total', () => {
    renderGrid();
    expect(screen.getByRole('grid', { name: /weekly timesheet/i })).toBeInTheDocument();
    expect(screen.getByText('Build the grid')).toBeInTheDocument();
    expect(screen.getByText('ENG-1')).toBeInTheDocument();
    expect(screen.getByLabelText(/week total 9:00/i)).toBeInTheDocument();
  });

  it('flags a daily total over 8 hours', () => {
    renderGrid();
    expect(screen.getByLabelText(/total 9:00, over 8 hours/i)).toBeInTheDocument();
  });

  it('commits a typed cell edit to onCellSave in minutes', () => {
    const { onCellSave } = renderGrid();
    const input = screen.getByDisplayValue('9:00');
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCellSave).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1' }),
      MONDAY,
      480,
    );
  });

  it('renders future-day cells inert so time cannot be logged ahead (#1926)', () => {
    // days = weekDays(MONDAY, MONDAY) → Mon is today, Tue..Sun are future.
    renderGrid();
    const futureCells = screen
      .getAllByRole('gridcell')
      .filter((c) => /future date, not loggable/.test(c.getAttribute('aria-label') ?? ''));
    // One inert future cell per row for each of Tue..Sun (6 days).
    expect(futureCells).toHaveLength(6);
    futureCells.forEach((c) => expect(c).toHaveAttribute('aria-readonly', 'true'));
  });

  it('surfaces a per-cell validation error passed for that (task, date) key (#1945)', () => {
    renderGrid({ cellErrors: { [`t1|${MONDAY}`]: 'Entry date cannot be in the future.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Entry date cannot be in the future.');
  });

  it('renders the add-task row while the week is open', () => {
    renderGrid();
    expect(screen.getByRole('button', { name: /add project or task/i })).toBeInTheDocument();
  });

  it('hides the add-task row and makes cells read-only once submitted', () => {
    renderGrid({ submitted: true });
    expect(screen.queryByRole('button', { name: /add project or task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
