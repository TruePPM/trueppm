import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter, renderWithProvidersAndRouter } from '@/test/utils';
import { ROLE_VIEWER, ROLE_MEMBER } from '@/lib/roles';
import type { Task } from '@/types';
import { CalendarView } from './CalendarView';

const calendarTasksMock = vi.hoisted(() => vi.fn());
const roleMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCalendarTasks', () => ({ useCalendarTasks: calendarTasksMock }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: roleMock }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useSprints', () => ({ useSprints: () => ({ sprints: [] }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => 'lg' }));
// Server-resolved methodology (#2619) — drives the explanatory empty state.
// Default (no data) lets the component's own `?? 'HYBRID'` fallback apply.
vi.mock('@/hooks/useProject', () => ({ useProject: projectMock }));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    singular: 'Sprint',
    plural: 'Sprints',
    lower: 'sprint',
    lowerPlural: 'sprints',
    possessive: "Sprint's",
  }),
}));
// Mutable so a case can drive the view mode (#3167); reset in beforeEach.
const calFilterMock = vi.hoisted(() => ({
  state: {
    calView: 'month' as 'month' | 'week',
    anchorIso: '2026-05-01',
  },
}));
vi.mock('./useCalendarFilter', () => ({
  useCalendarFilter: () => ({
    calView: calFilterMock.state.calView,
    anchorIso: calFilterMock.state.anchorIso,
    setCalView: vi.fn(),
    goToToday: vi.fn(),
    goNext: vi.fn(),
    goPrev: vi.fn(),
  }),
}));
// Stub the heavy grid + modal — this suite exercises CalendarView's state
// branching, not their internals.
vi.mock('./CalendarGrid', () => ({
  CalendarGrid: ({ calView }: { calView?: string }) => (
    <div data-testid="calendar-grid" data-cal-view={calView} />
  ),
}));
vi.mock('@/features/board/TaskFormModal', () => ({
  TaskFormModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="New task">
      <button type="button" onClick={onClose}>
        close-modal
      </button>
    </div>
  ),
}));

const sampleTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Task 1',
  start: '2026-05-05',
  finish: '2026-05-08',
  duration: 4,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
};

const refetch = vi.fn();

beforeEach(() => {
  calendarTasksMock.mockReturnValue({ tasks: [], isLoading: false, error: null, refetch });
  roleMock.mockReturnValue({ role: ROLE_MEMBER, roleLabel: null, isLoading: false });
  projectMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
  calFilterMock.state = { calView: 'month', anchorIso: '2026-05-01' };
});
afterEach(() => vi.clearAllMocks());

describe('CalendarView state branches (#2161)', () => {
  it('shows a busy skeleton while loading — never the empty copy', () => {
    calendarTasksMock.mockReturnValue({ tasks: [], isLoading: true, error: null, refetch });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByRole('status', { name: 'Loading calendar' })).toBeInTheDocument();
    expect(screen.queryByText(/No tasks yet/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('calendar-grid')).not.toBeInTheDocument();
  });

  it('shows a retry-able error state on fetch failure — never the empty copy', async () => {
    calendarTasksMock.mockReturnValue({
      tasks: [],
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the calendar.");
    expect(screen.queryByText(/No tasks yet/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state with a create CTA for a Member+', () => {
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add task' })).toBeInTheDocument();
  });

  it('omits the create CTA for a Viewer', () => {
    roleMock.mockReturnValue({ role: ROLE_VIEWER, roleLabel: null, isLoading: false });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add task' })).not.toBeInTheDocument();
  });

  it('opens the task-create modal from the empty-state CTA', async () => {
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    await userEvent.click(screen.getByRole('button', { name: '+ Add task' }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
  });

  it('renders the grid when tasks are present', () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByTestId('calendar-grid')).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });

  // #2619: AGILE hides this route's nav entry, but it stays reachable by direct
  // URL — the bug was the cold-start CTA never saying so.
  it('shows the methodology-mismatch empty state on an AGILE project', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText("Calendar isn't part of this project's workflow")).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Sprints' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
  });

  it('keeps the generic empty state on a non-AGILE project', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'HYBRID' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(
      screen.queryByText("Calendar isn't part of this project's workflow"),
    ).not.toBeInTheDocument();
  });
});

describe('CalendarView week mode (#3167)', () => {
  it('heads the toolbar with the month name in month mode', () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByRole('heading', { level: 2, name: 'May 2026' })).toBeInTheDocument();
  });

  it('heads the toolbar with the week range in week mode', () => {
    calFilterMock.state = { calView: 'week', anchorIso: '2026-05-01' };
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Apr 27 \u2013 May 3, 2026' }),
    ).toBeInTheDocument();
  });

  it('threads calView down to the grid — the defect was that it did not', () => {
    calFilterMock.state = { calView: 'week', anchorIso: '2026-05-01' };
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-cal-view', 'week');
  });

  it('mounts the live region empty — no announcement on first paint', () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    // Present in the a11y tree from the start (so a later write is a mutation of
    // an existing node), but silent until the user actually changes something.
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('');
  });

  it('announces the window after a mode change', async () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    // renderWithRouter bakes the element into createMemoryRouter, so its
    // rerender does not reach the component (see src/test/utils.tsx). This case
    // needs a real rerender to fire the effect, so it uses the MemoryRouter form.
    const { rerender } = renderWithProvidersAndRouter(<CalendarView />, {
      initialEntries: ['/projects/proj-1?view=calendar'],
    });
    calFilterMock.state = { calView: 'week', anchorIso: '2026-05-01' };
    rerender(<CalendarView />);
    expect(await screen.findByText('Week view, Apr 27 \u2013 May 3, 2026')).toBeInTheDocument();
  });

  it('marks the active mode with a filled toggle, not color alone (WCAG 1.4.1)', () => {
    calFilterMock.state = { calView: 'week', anchorIso: '2026-05-01' };
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    const week = screen.getByRole('button', { name: 'week' });
    expect(week).toHaveAttribute('aria-pressed', 'true');
    expect(week.className).toContain('bg-brand-primary');
    expect(week.className).not.toContain('bg-brand-primary/10');
  });
});
