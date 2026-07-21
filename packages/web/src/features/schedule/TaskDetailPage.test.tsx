import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

import type { Task } from '@/types';
import { TaskDetailPage } from './TaskDetailPage';

let TASKS: Partial<Task>[] = [];
let LOADING = false;
let ROLE: number | null = 300; // Admin by default so edit affordances render.

const { mutate, sectionListSpy, scheduleStripSpy } = vi.hoisted(() => ({
  mutate: vi.fn(),
  sectionListSpy: vi.fn(),
  scheduleStripSpy: vi.fn(),
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS, isLoading: LOADING }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: ROLE }),
}));
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate }),
}));
// Stub the heavy section renderer + schedule strip so the page test stays a unit;
// capture their props to assert the server canEdit verdict is threaded through.
vi.mock('./TaskDetailDrawer', () => ({
  SectionList: (props: { canEdit?: boolean }) => {
    sectionListSpy(props);
    return <div data-testid="section-list" />;
  },
}));
vi.mock('./TaskScheduleStrip', () => ({
  TaskScheduleStrip: (props: { canEdit?: boolean }) => {
    scheduleStripSpy(props);
    return <div data-testid="schedule-strip" />;
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/tasks/t1']}>
      <Routes>
        <Route path="/projects/:projectId/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  TASKS = [];
  LOADING = false;
  ROLE = 300;
  vi.clearAllMocks();
});

describe('TaskDetailPage', () => {
  it('renders the task title, schedule strip, sections, and a back link', () => {
    TASKS = [{ id: 't1', name: 'Foundation', wbs: '1.2', canEdit: true }];
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: /Foundation/ })).toHaveTextContent(
      '1.2 — Foundation',
    );
    expect(screen.getByTestId('schedule-strip')).toBeInTheDocument();
    expect(screen.getByTestId('section-list')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to schedule/ })).toHaveAttribute(
      'href',
      '/projects/p1/schedule',
    );
  });

  it('shows a not-found state when the task is absent', () => {
    TASKS = [];
    renderPage();
    expect(screen.getByText('Task not found.')).toBeInTheDocument();
    expect(screen.queryByTestId('section-list')).not.toBeInTheDocument();
  });

  it('shows a loading state while tasks resolve', () => {
    TASKS = [];
    LOADING = true;
    renderPage();
    expect(screen.getByText('Loading task…')).toBeInTheDocument();
  });

  it('renders an editable name and Description, and threads canEdit through', () => {
    TASKS = [{ id: 't1', name: 'Foundation', wbs: '1.2', canEdit: true, notes: 'Pour footings' }];
    renderPage();

    const nameInput = screen.getByRole('textbox', { name: 'Task name' });
    expect(nameInput).toHaveValue('Foundation');
    expect(nameInput).not.toHaveAttribute('readonly');
    // Description is present and editable (read-mode click-to-edit affordance).
    expect(screen.getByRole('button', { name: 'Description' })).toBeInTheDocument();

    // The server canEdit verdict flows to the sections and the schedule strip.
    expect(sectionListSpy).toHaveBeenCalledWith(expect.objectContaining({ canEdit: true }));
    expect(scheduleStripSpy).toHaveBeenCalledWith(expect.objectContaining({ canEdit: true }));
  });

  it('commits a name edit on blur with a baseVersion, and never persists an empty name', () => {
    TASKS = [{ id: 't1', name: 'Foundation', canEdit: true, serverVersion: 7 }];
    renderPage();
    const nameInput = screen.getByRole('textbox', { name: 'Task name' });

    fireEvent.change(nameInput, { target: { value: 'Foundation A' } });
    fireEvent.blur(nameInput);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', name: 'Foundation A', baseVersion: 7 }),
    );

    mutate.mockClear();
    // Blank name reverts to the saved value rather than issuing a wipe PATCH.
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.blur(nameInput);
    expect(mutate).not.toHaveBeenCalled();
    expect(nameInput).toHaveValue('Foundation');
  });

  it('commits a Description edit on blur', () => {
    TASKS = [{ id: 't1', name: 'Foundation', canEdit: true, notes: '', serverVersion: 3 }];
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Description' }));
    const textarea = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(textarea, { target: { value: 'New scope' } });
    fireEvent.blur(textarea);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', notes: 'New scope', baseVersion: 3 }),
    );
  });

  it('renders read-only for a non-editable task (server verdict) and never mutates', () => {
    TASKS = [{ id: 't1', name: 'Foundation', canEdit: false, notes: 'Locked' }];
    ROLE = 300; // Admin role, but the server per-task verdict wins.
    renderPage();
    expect(screen.getByRole('textbox', { name: 'Task name' })).toHaveAttribute('readonly');
    // No click-to-edit Description affordance when read-only.
    expect(screen.queryByRole('button', { name: 'Description' })).not.toBeInTheDocument();
    expect(sectionListSpy).toHaveBeenCalledWith(expect.objectContaining({ canEdit: false }));
    expect(mutate).not.toHaveBeenCalled();
  });
});
