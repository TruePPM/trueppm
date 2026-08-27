/**
 * The gutter row's date-gated promote disclosure (#3075).
 *
 * Every control in this row writes `planned_start`, which on a NOT_STARTED task also
 * flips it to In progress once the date has arrived (`_apply_date_gated_start_transition`,
 * #336) — and back-stamps `actual_start` for a date in the past. The controls are named
 * for the date and said nothing about the status.
 *
 * These tests drive the row directly rather than through `UnscheduledGutter`, because
 * `serverDate` is the row's contract with its parent: the gutter's only job is to read
 * `server_date` off the project and hand it down, and testing through it would make the
 * assertions depend on a project query resolving.
 *
 * The clock is pinned and every date is derived from the pin — the assertion is a
 * comparison against a date, so a literal would silently start testing another branch.
 */

import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';

import { UnscheduledTaskRow } from './UnscheduledTaskRow';
import { startCommitClause } from './startCommitDisclosure';

const SERVER_TODAY = '2026-08-27';

function shift(days: number): string {
  const [y, m, d] = SERVER_TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '',
    finish: '',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

function openMenu(task: Task, serverDate?: string): void {
  render(<UnscheduledTaskRow task={task} variant="todo" serverDate={serverDate} />);
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${task.name}` }));
}

describe('UnscheduledTaskRow — date-gated promote disclosure', () => {
  beforeEach(() => {
    // The browser clock is pinned to the same day the server reports, so any
    // difference an assertion sees comes from the branch under test rather than from
    // the two clocks drifting during the run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${SERVER_TODAY}T12:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it('names the status change on "Start today"', () => {
    openMenu(makeTask({ name: 'Ready', start: shift(5) }), SERVER_TODAY);
    expect(
      screen.getByRole('menuitem', { name: /Start today.*also marks this task In progress/i }),
    ).toBeInTheDocument();
  });

  it('leaves "Start at the earliest" silent when the earliest has not arrived', () => {
    openMenu(makeTask({ name: 'Blocked', start: shift(5) }), SERVER_TODAY);
    const earliest = screen.getByRole('menuitem', { name: /Start at the earliest/i });
    expect(earliest.textContent).not.toMatch(/In progress/i);
  });

  it('names the backdating when the earliest is already in the past', () => {
    // A slipped plan: CPM's earliest is behind the server's today, so committing it
    // writes an actual_start as well as a status.
    openMenu(makeTask({ name: 'Slipped', start: shift(-4) }), SERVER_TODAY);
    expect(
      screen.getByRole('menuitem', { name: /In progress, backdated to that day/i }),
    ).toBeInTheDocument();
  });

  it('says nothing at all when the server date is unknown', () => {
    // No project payload yet — the labels must read exactly as they did before this
    // disclosure existed, rather than falling back to the browser's clock.
    openMenu(makeTask({ name: 'Slipped', start: shift(-4) }));
    screen.getByRole('menuitem', { name: /Start at the earliest/i });
    expect(screen.queryByText(/In progress/i)).not.toBeInTheDocument();
  });

  it('says nothing for a task that is not NOT_STARTED', () => {
    // The promote only fires from NOT_STARTED, so claiming it for an in-progress row
    // would be a disclosure of something that will not happen.
    openMenu(makeTask({ name: 'Underway', start: shift(-4), status: 'IN_PROGRESS' }), SERVER_TODAY);
    screen.getByRole('menuitem', { name: /Start at the earliest/i });
    expect(screen.queryByText(/In progress,/i)).not.toBeInTheDocument();
  });

  it('discloses on the picked date, and updates as the date changes', () => {
    const task = makeTask({ name: 'Pickable', start: shift(5) });
    render(<UnscheduledTaskRow task={task} variant="todo" serverDate={SERVER_TODAY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Pickable' }));

    const input = screen.getByLabelText('Or pick a date');
    fireEvent.change(input, { target: { value: shift(10) } });
    // Scoped to the Promote button: the "Start today" quick action above it carries
    // its own clause and is a different control's disclosure.
    expect(screen.getByRole('button', { name: 'Promote to schedule' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: shift(-1) } });
    expect(
      screen.getByRole('button', { name: /Promote to schedule.*In progress, backdated/i }),
    ).toBeInTheDocument();
  });

  it('leaves the Promote button its plain accessible name when nothing extra happens', () => {
    // The e2e specs locate this button by its exact name; it must not gain a suffix
    // on the ordinary future-dated path.
    const task = makeTask({ name: 'Future', start: shift(5) });
    render(<UnscheduledTaskRow task={task} variant="todo" serverDate={SERVER_TODAY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Future' }));
    fireEvent.change(screen.getByLabelText('Or pick a date'), {
      target: { value: shift(9) },
    });
    expect(screen.getByRole('button', { name: 'Promote to schedule' })).toBeInTheDocument();
  });

  it('renders the same clause the drawer does, from the same input', () => {
    // The issue's explicit requirement: one shared helper drives both surfaces, so
    // they cannot drift into making different promises about the same write. Asserted
    // by comparing the rendered menu item against the helper's own output rather than
    // against a copy of the sentence — a duplicated literal here would pass while the
    // two surfaces diverged.
    const start = shift(-2);
    openMenu(makeTask({ name: 'Slipped', start }), SERVER_TODAY);
    const clause = startCommitClause(start, SERVER_TODAY);
    expect(clause).not.toBeNull();
    const item = screen.getByRole('menuitem', { name: /Start at the earliest/i });
    expect(item.textContent).toContain(clause as string);
  });
});
