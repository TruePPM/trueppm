import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { OverviewSection } from './OverviewSection';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

const updateMock = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: updateMock, isPending: false }),
}));

// ResourceAssignmentSection makes its own queries — stub it out.
vi.mock('../ResourceAssignmentSection', () => ({
  ResourceAssignmentSection: () => null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Widget work',
  start: '2026-04-01',
  finish: '2026-04-10',
  duration: 7,
  progress: 40,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'IN_PROGRESS',
  assignees: [],
  notes: '',
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks.splice(0, mockTasks.length, baseTask);
});

// ---------------------------------------------------------------------------
// Status selector (#405)
// ---------------------------------------------------------------------------

describe('OverviewSection — status select', () => {
  it('renders an editable status select for leaf tasks', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('combobox', { name: /Task status/i })).toBeInTheDocument();
  });

  it('select reflects the current task status', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const select = screen.getByRole('combobox', { name: /Task status/i });
    expect(select).toHaveValue('IN_PROGRESS');
  });

  it('fires updateTask on status change', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const select = screen.getByRole('combobox', { name: /Task status/i });
    fireEvent.change(select, { target: { value: 'REVIEW' } });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'REVIEW' }),
    );
  });

  it('shows BacklogDemoteConfirmDialog when demoting from IN_PROGRESS to BACKLOG', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const select = screen.getByRole('combobox', { name: /Task status/i });
    fireEvent.change(select, { target: { value: 'BACKLOG' } });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('fires updateTask with BACKLOG after demotion is confirmed', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const select = screen.getByRole('combobox', { name: /Task status/i });
    fireEvent.change(select, { target: { value: 'BACKLOG' } });
    fireEvent.click(screen.getByRole('button', { name: /Move to Backlog/i }));
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'BACKLOG' }),
    );
  });

  it('cancels demotion without firing updateTask', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const select = screen.getByRole('combobox', { name: /Task status/i });
    fireEvent.change(select, { target: { value: 'BACKLOG' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not show BacklogDemoteDialog when moving from NOT_STARTED to BACKLOG', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, status: 'NOT_STARTED' });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const select = screen.getByRole('combobox', { name: /Task status/i });
    fireEvent.change(select, { target: { value: 'BACKLOG' } });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'BACKLOG' }),
    );
  });

  it('shows read-only status text for summary tasks (no select)', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, isSummary: true });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('combobox', { name: /Task status/i })).not.toBeInTheDocument();
    expect(screen.getByText(/In progress/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Progress field (#406)
// ---------------------------------------------------------------------------

describe('OverviewSection — progress field', () => {
  it('renders a numeric progress input for leaf tasks', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('spinbutton', { name: /Task progress/i })).toBeInTheDocument();
  });

  it('pre-fills with the current progress value', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('spinbutton', { name: /Task progress/i })).toHaveValue(40);
  });

  it('fires updateTask with percent_complete on blur', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('spinbutton', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.blur(input);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', percent_complete: 75 }),
    );
  });

  it('clamps values above 100', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('spinbutton', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ percent_complete: 100 }),
    );
  });

  it('clamps values below 0', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('spinbutton', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ percent_complete: 0 }),
    );
  });

  it('disables the progress input when status is COMPLETE', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, status: 'COMPLETE', progress: 100 });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('spinbutton', { name: /Task progress/i })).toBeDisabled();
  });

  it('renders read-only progress for summary tasks', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, isSummary: true, progress: 55 });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByText(/55%/)).toBeInTheDocument();
    expect(screen.getByText(/rolled up/i)).toBeInTheDocument();
  });
});
