import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

import type { Task } from '@/types';
import { TaskDetailPage, findTaskByRef } from './TaskDetailPage';

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

  // ----- Task references (ADR-1237 §7) -----------------------------------------

  function Where() {
    const location = useLocation();
    return <span data-testid="where">{location.pathname}</span>;
  }

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/projects/:projectId/tasks/:taskId"
            element={
              <>
                <TaskDetailPage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('opens a task by its display reference under a keyed project', () => {
    TASKS = [{ id: 't1', name: 'Foundation', shortId: '0000000A', shortIdDisplay: 'T-10' }];
    renderAt('/projects/PLAT/tasks/T-10');
    expect(screen.getByRole('heading', { level: 1, name: /Foundation/ })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/tasks/T-10');
    expect(screen.getByRole('link', { name: /Back to schedule/ })).toHaveAttribute(
      'href',
      '/projects/PLAT/schedule',
    );
  });

  it('rewrites a UUID or raw hex task segment to the display reference', () => {
    TASKS = [{ id: 't1', name: 'Foundation', shortId: '0000000A', shortIdDisplay: 'T-10' }];
    renderAt('/projects/PLAT/tasks/t1');
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/tasks/T-10');
  });

  it('shows the task-not-found state for an unknown reference inside the project', () => {
    TASKS = [{ id: 't1', name: 'Foundation', shortIdDisplay: 'T-10' }];
    renderAt('/projects/PLAT/tasks/T-999');
    expect(screen.getByText('Task not found.')).toBeInTheDocument();
  });

  it('matches only server-formatted values — it never decodes a reference', () => {
    const tasks = [
      { id: 't1', shortId: '0000000A', shortIdDisplay: 'T-10' },
    ] as unknown as Parameters<typeof findTaskByRef>[0];
    expect(findTaskByRef(tasks, 't-10')?.id).toBe('t1');
    expect(findTaskByRef(tasks, '0000000a')?.id).toBe('t1');
    expect(findTaskByRef(tasks, 'T-0010')).toBeUndefined();
    expect(findTaskByRef(tasks, '10')).toBeUndefined();
  });
});
