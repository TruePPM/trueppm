import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ROLE_VIEWER, ROLE_MEMBER } from '@/lib/roles';
import type { Task } from '@/types';
import { CalendarView } from './CalendarView';

const calendarTasksMock = vi.hoisted(() => vi.fn());
const roleMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCalendarTasks', () => ({ useCalendarTasks: calendarTasksMock }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: roleMock }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useSprints', () => ({ useSprints: () => ({ sprints: [] }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => 'lg' }));
vi.mock('./useCalendarFilter', () => ({
  useCalendarFilter: () => ({
    calView: 'month',
    anchorIso: '2026-05-01',
    setCalView: vi.fn(),
    goToToday: vi.fn(),
    goNext: vi.fn(),
    goPrev: vi.fn(),
  }),
}));
// Stub the heavy grid + modal — this suite exercises CalendarView's state
// branching, not their internals.
vi.mock('./CalendarGrid', () => ({
  CalendarGrid: () => <div data-testid="calendar-grid" />,
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
  id: 't1', wbs: '1', name: 'Task 1', start: '2026-05-05', finish: '2026-05-08',
  duration: 4, progress: 0, parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

const refetch = vi.fn();

beforeEach(() => {
  calendarTasksMock.mockReturnValue({ tasks: [], isLoading: false, error: null, refetch });
  roleMock.mockReturnValue({ role: ROLE_MEMBER, roleLabel: null, isLoading: false });
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
      tasks: [], isLoading: false, error: new Error('boom'), refetch,
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
    calendarTasksMock.mockReturnValue({ tasks: [sampleTask], isLoading: false, error: null, refetch });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByTestId('calendar-grid')).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });
});
