import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { TimesheetPage } from './TimesheetPage';
import { localDateIso } from '@/lib/localDate';
import { mondayOf, type WeeklyEntry, type WeeklyResponse } from './weekModel';

vi.mock('@/hooks/useWeekTimesheet', () => ({
  useWeekTimesheet: vi.fn(),
  useTimesheetCell: vi.fn(),
  useSubmitWeek: vi.fn(),
}));
vi.mock('@/hooks/useTimesheetAssignments', () => ({
  useTimesheetAssignments: vi.fn(),
}));

import {
  useWeekTimesheet,
  useTimesheetCell,
  useSubmitWeek,
} from '@/hooks/useWeekTimesheet';
import { useTimesheetAssignments } from '@/hooks/useTimesheetAssignments';

const mockUseWeek = useWeekTimesheet as ReturnType<typeof vi.fn>;
const mockUseCell = useTimesheetCell as ReturnType<typeof vi.fn>;
const mockUseSubmit = useSubmitWeek as ReturnType<typeof vi.fn>;
const mockUseAssignments = useTimesheetAssignments as ReturnType<typeof vi.fn>;

/** A `/me/work/` task row with only the fields the timesheet reads. */
function myWorkTask(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, short_id: id.toUpperCase(), name, project_id: 'p1', project_name: 'Web', status: 'IN_PROGRESS', due: null, ...extra };
}

function setAssignments(tasks: unknown[], state: Record<string, unknown> = {}) {
  mockUseAssignments.mockReturnValue({ data: { tasks, partial: false }, isLoading: false, isError: false, refetch: vi.fn(), ...state });
}

const submitMutate = vi.fn();
const cellMutate = vi.fn();
const refetch = vi.fn();

/**
 * A fixed instant the whole suite runs at, so "this week" is the same fact for the
 * fixture and for the page. Noon UTC keeps the *local* calendar day inside
 * 2026-06-17/18 for every real timezone, both of which sit in the week beginning
 * Monday 2026-06-15 — the `week_start` the submission fixture already declares.
 */
const PINNED_NOW = new Date('2026-06-17T12:00:00Z');

// Anchor the seeded entry to the currently-displayed week so its editable cell renders
// (the grid only paints the seven day columns of the open week). Derived from the pinned
// instant's *local* calendar day, exactly as the page derives its week — reading
// `toISOString()` here took the UTC day instead, so on any evening west of UTC the entry
// landed in a week the grid was not showing and its cell input never rendered (#2453).
// CI runners are UTC, where the two agree, so the pipeline could never see it.
const THIS_MONDAY = mondayOf(localDateIso(PINNED_NOW));

function weekEntry(minutes: number): WeeklyEntry {
  return {
    id: 'e1',
    task: 't1',
    task_short_id: 'ENG-1',
    task_name: 'Build the grid',
    project: 'p1',
    project_code: 'WEB',
    project_name: 'Web',
    minutes,
    entry_date: THIS_MONDAY,
    note: '',
    source: 'manual',
    server_version: 1,
    created_at: `${THIS_MONDAY}T09:00:00Z`,
  };
}

function weekData(submitted: boolean, entries: WeeklyEntry[]): WeeklyResponse {
  return {
    results: entries,
    totals: { by_day: {}, by_cell: {}, today_minutes: 0, week_minutes: 0 },
    submission: {
      week_start: '2026-06-15',
      submitted,
      submitted_at: submitted ? '2026-06-16T00:00:00Z' : null,
    },
  };
}

function setWeek(state: Record<string, unknown>) {
  mockUseWeek.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch, ...state });
}

beforeEach(() => {
  // The page opens on the week containing "now", so "now" has to be a fixed fact rather
  // than whatever the wall clock says when the suite runs (#2453).
  vi.useFakeTimers();
  vi.setSystemTime(PINNED_NOW);
  vi.clearAllMocks();
  mockUseCell.mockReturnValue({ mutate: cellMutate, isPending: false });
  mockUseSubmit.mockReturnValue({ mutate: submitMutate, isPending: false });
  setAssignments([]);
  setWeek({ data: weekData(false, [weekEntry(120)]) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TimesheetPage', () => {
  it('shows a loading placeholder while the week loads', () => {
    setWeek({ isLoading: true });
    render(<TimesheetPage />);
    expect(screen.getByLabelText('Loading timesheet')).toBeInTheDocument();
  });

  it('shows an error state and retries on demand', () => {
    setWeek({ isError: true });
    render(<TimesheetPage />);
    expect(screen.getByText(/couldn.t load your timesheet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('submits the week when there is logged time', () => {
    render(<TimesheetPage />);
    const submit = screen.getByRole('button', { name: /submit week/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(submitMutate).toHaveBeenCalledWith(true);
  });

  it('disables submit when the week has no logged time', () => {
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);
    expect(screen.getByRole('button', { name: /submit week/i })).toBeDisabled();
  });

  it('offers Reopen once the week is submitted', () => {
    setWeek({ data: weekData(true, [weekEntry(120)]) });
    render(<TimesheetPage />);
    expect(screen.getAllByText('Submitted').length).toBeGreaterThan(0);
    const reopen = screen.getByRole('button', { name: /reopen week/i });
    fireEvent.click(reopen);
    expect(submitMutate).toHaveBeenCalledWith(false);
  });

  it('says a submitted week is not locked, so the inert grid is not read as enforcement (#2701)', () => {
    // The grid renders a submitted week read-only, but ADR-0224 ships submission as a
    // marker — "no approver, no lock, no return" — and the API accepts a PATCH to an
    // entry in a submitted week. Three of eight VoC personas read the inert grid as a
    // server-side lock. This line is the only thing that contradicts that inference.
    setWeek({ data: weekData(true, [weekEntry(120)]) });
    render(<TimesheetPage />);
    expect(screen.getByText(/doesn’t lock your time/i)).toBeInTheDocument();
  });

  it('does not claim the week is unlocked before it is submitted', () => {
    setWeek({ data: weekData(false, [weekEntry(120)]) });
    render(<TimesheetPage />);
    expect(screen.queryByText(/doesn’t lock your time/i)).not.toBeInTheDocument();
  });

  it('steps to the next and previous week', () => {
    render(<TimesheetPage />);
    const label = () => screen.getByText(/–/).textContent ?? '';
    const start = label();
    fireEvent.click(screen.getByRole('button', { name: /next week/i }));
    expect(label()).not.toBe(start);
    fireEvent.click(screen.getByRole('button', { name: /previous week/i }));
    expect(label()).toBe(start);
  });

  it('commits an edited cell through the cell mutation', () => {
    render(<TimesheetPage />);
    const input = screen.getByDisplayValue('2:00');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(cellMutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = cellMutate.mock.calls[0] as [
      { date: string; minutes: number; entryId: string | null },
      { onError?: unknown },
    ];
    expect(vars).toMatchObject({ date: THIS_MONDAY, minutes: 180, entryId: 'e1' });
    // The page routes rejections back to the cell via a per-call onError (#1945).
    expect(typeof opts.onError).toBe('function');
  });

  it('shows a rejected save inline on the cell, then clears it on re-edit (#1945)', () => {
    const rejection = new AxiosError('Request failed with status code 400');
    rejection.response = {
      status: 400,
      data: { entry_date: ['Entry date cannot be in the future.'] },
    } as AxiosResponse;
    // Drive the per-call onError the page passes so the 400 surfaces on the cell.
    cellMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (e: unknown) => void }) => opts?.onError?.(rejection),
    );

    render(<TimesheetPage />);
    const input = screen.getByDisplayValue('2:00');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The reason is shown inline (role="alert"), NOT via a toast or the sync badge.
    expect(screen.getByRole('alert')).toHaveTextContent('Entry date cannot be in the future.');

    // Re-editing the cell clears the inline error first (editing IS the re-validation).
    cellMutate.mockImplementation(() => undefined);
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders an open assigned task with no entries as a row of zeros (#4766)', () => {
    setAssignments([
      myWorkTask('t2', 'Wire the hook', { due: '2020-01-01' }), // overdue, still open
      myWorkTask('t3', 'A phase', { is_phase: true }),
      myWorkTask('t4', 'Shipped work', { status: 'COMPLETE' }),
    ]);
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);

    const grid = screen.getByRole('grid', { name: 'Weekly timesheet' });
    expect(within(grid).getByText('Wire the hook')).toBeInTheDocument();
    // A phase is never a loggable assignment — same filter My Work applies.
    expect(within(grid).queryByText('A phase')).not.toBeInTheDocument();
    // Finished work gets no zero row…
    expect(within(grid).queryByText('Shipped work')).not.toBeInTheDocument();
    // Its cells are editable inputs ready for the first hours of the week.
    expect(within(grid).getAllByLabelText(/T2 Wire the hook, Mon/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('adds a completed assigned task through the picker as a row (#4766)', () => {
    setAssignments([
      myWorkTask('t2', 'Wire the hook'),
      myWorkTask('t4', 'Shipped work', { status: 'COMPLETE' }),
    ]);
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);

    fireEvent.click(screen.getByRole('button', { name: /add project or task/i }));
    // The picker offers exactly the assigned tasks that are not rows.
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: /shipped work/i }));
    const grid = screen.getByRole('grid', { name: 'Weekly timesheet' });
    expect(within(grid).getByText('Shipped work')).toBeInTheDocument();
  });

  it('shows the empty state only when nothing is assigned and nothing is logged (#4766)', () => {
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nothing assigned to you this week' })).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('names the week in the empty state when it is not the current one (#4766)', () => {
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(
      screen.getByRole('heading', { name: 'Nothing assigned to you for the week of Jun 8 – 14, 2026' }),
    ).toBeInTheDocument();
  });

  it('waits for the assignments before deciding the week is empty (#4766)', () => {
    mockUseAssignments.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);
    expect(screen.getByLabelText('Loading timesheet')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('does not claim "nothing assigned" when the assignments failed to load (#4766)', () => {
    mockUseAssignments.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    setWeek({ data: weekData(false, []) });
    render(<TimesheetPage />);
    expect(screen.getByText(/couldn.t load your timesheet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('flags a partially loaded assignment list instead of a silently partial grid (#4766)', () => {
    mockUseAssignments.mockReturnValue({
      data: { tasks: [myWorkTask('t2', 'Wire the hook')], partial: true },
      isLoading: false,
      isError: false,
    });
    render(<TimesheetPage />);
    expect(screen.getByTestId('timesheet-partial-assignments')).toHaveTextContent(
      /assigned tasks couldn.t be loaded/i,
    );
    expect(screen.getByRole('grid', { name: 'Weekly timesheet' })).toBeInTheDocument();
  });

  it('shows no partial notice when the assignment list is complete', () => {
    render(<TimesheetPage />);
    expect(screen.queryByTestId('timesheet-partial-assignments')).not.toBeInTheDocument();
  });
});
