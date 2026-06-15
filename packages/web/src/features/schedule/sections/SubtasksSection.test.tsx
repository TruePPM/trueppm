import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { SubtasksSection } from './SubtasksSection';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

const mockCreate = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({ mutate: mockCreate, isPending: false }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTask: Task = {
  id: 'parent-1',
  wbs: '1',
  name: 'Parent task',
  start: '2026-04-01',
  finish: '2026-04-10',
  duration: 7,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
  isSubtask: false,
};

const subtask1: Task = {
  ...baseTask,
  id: 'sub-1',
  name: 'First subtask',
  parentId: 'parent-1',
  isSubtask: true,
  status: 'IN_PROGRESS',
  progress: 50,
};

const subtask2: Task = {
  ...baseTask,
  id: 'sub-2',
  name: 'Second subtask',
  parentId: 'parent-1',
  isSubtask: true,
  status: 'COMPLETE',
  progress: 100,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubtasksSection', () => {
  it('returns null when task is not found', () => {
    mockTasks.splice(0, mockTasks.length);
    const { container } = renderWithProviders(
      <SubtasksSection taskId="missing" projectId="p1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows empty-state message when task has no subtasks', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" canEdit />);
    expect(screen.getByText(/No subtasks yet/i)).toBeInTheDocument();
  });

  it('renders Add subtask button', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" canEdit />);
    expect(screen.getByRole('button', { name: /add subtask/i })).toBeInTheDocument();
  });

  it('shows inline form on Add subtask click', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add subtask/i }));
    expect(screen.getByRole('textbox', { name: /new subtask name/i })).toBeInTheDocument();
  });

  it('dismisses form on cancel', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add subtask/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel adding subtask/i }));
    expect(screen.queryByRole('textbox', { name: /new subtask name/i })).not.toBeInTheDocument();
  });

  it('calls createTask with is_subtask: true on form submit', () => {
    mockCreate.mockClear();
    mockTasks.splice(0, mockTasks.length, baseTask);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add subtask/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /new subtask name/i }), {
      target: { value: 'My new subtask' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My new subtask', is_subtask: true, parent_id: 'parent-1' }),
      expect.anything(),
    );
  });

  it('renders existing subtasks with status dots', () => {
    mockTasks.splice(0, mockTasks.length, baseTask, subtask1, subtask2);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" />);
    expect(screen.getByText('First subtask')).toBeInTheDocument();
    expect(screen.getByText('Second subtask')).toBeInTheDocument();
  });

  it('shows completion count badge', () => {
    mockTasks.splice(0, mockTasks.length, baseTask, subtask1, subtask2);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" />);
    // One of the two is COMPLETE → "1/2"
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('shows progress bar', () => {
    mockTasks.splice(0, mockTasks.length, baseTask, subtask1, subtask2);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" />);
    expect(screen.getByRole('progressbar', { name: /subtask completion/i })).toBeInTheDocument();
  });

  it('shows all-complete message when every subtask is done', () => {
    const doneSubtask: Task = { ...subtask1, id: 'sub-done', status: 'COMPLETE', progress: 100 };
    mockTasks.splice(0, mockTasks.length, baseTask, doneSubtask);
    renderWithProviders(<SubtasksSection taskId="parent-1" projectId="p1" />);
    expect(screen.getByText(/all complete/i)).toBeInTheDocument();
  });

  it('shows disabled message for subtask-of-subtask attempt', () => {
    const subtaskTask: Task = { ...baseTask, id: 'sub-only', isSubtask: true };
    mockTasks.splice(0, mockTasks.length, subtaskTask);
    renderWithProviders(<SubtasksSection taskId="sub-only" projectId="p1" />);
    expect(screen.getByText(/cannot be nested/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add subtask/i })).not.toBeInTheDocument();
  });
});
