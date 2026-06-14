import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

import type { Task } from '@/types';
import { TaskDetailPage } from './TaskDetailPage';

let TASKS: Partial<Task>[] = [];
let LOADING = false;
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS, isLoading: LOADING }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 3 }),
}));
// Stub the heavy section renderer + schedule strip so the page test stays a unit.
vi.mock('./TaskDetailDrawer', () => ({
  SectionList: () => <div data-testid="section-list" />,
}));
vi.mock('./TaskScheduleStrip', () => ({
  TaskScheduleStrip: () => <div data-testid="schedule-strip" />,
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
  vi.clearAllMocks();
});

describe('TaskDetailPage', () => {
  it('renders the task title, schedule strip, sections, and a back link', () => {
    TASKS = [{ id: 't1', name: 'Foundation', wbs: '1.2' }];
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
});
