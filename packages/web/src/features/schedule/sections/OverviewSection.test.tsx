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
const mockParseProgressAnchorError = vi.hoisted(() =>
  vi.fn(
    () =>
      null as null | {
        code: 'progress_requires_anchor';
        detail: string;
        suggested_action: 'set_planned_start' | 'assign_sprint';
      },
  ),
);

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: updateMock, isPending: false }),
  parseProgressAnchorError: mockParseProgressAnchorError,
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
  mockParseProgressAnchorError.mockReturnValue(null);
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
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'BACKLOG' }));
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
  it('renders a progress slider for leaf tasks', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('slider', { name: /Task progress/i })).toBeInTheDocument();
  });

  it('pre-fills with the current progress value', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('slider', { name: /Task progress/i })).toHaveValue('40');
  });

  it('fires updateTask with percent_complete on blur', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('slider', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.blur(input);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', percent_complete: 75 }),
      expect.any(Object),
    );
  });

  it('clamps values above 100', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('slider', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ percent_complete: 100 }),
      expect.any(Object),
    );
  });

  it('clamps values below 0', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('slider', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ percent_complete: 0 }),
      expect.any(Object),
    );
  });

  it('disables the progress input when status is COMPLETE', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, status: 'COMPLETE', progress: 100 });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('slider', { name: /Task progress/i })).toBeDisabled();
  });

  it('renders read-only progress for summary tasks', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, isSummary: true, progress: 55 });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/55%/)).toBeInTheDocument();
    expect(screen.getByText(/rolled up/i)).toBeInTheDocument();
  });

  // ----- Pass 3: edge cases — anchor error, no-op blur, non-numeric reset ----

  it('shows the progress anchor error message when the API rejects with progress_requires_anchor', async () => {
    // Make mutate invoke onError synchronously so the state update fires in the same tick.
    updateMock.mockImplementationOnce(
      (_payload: unknown, options?: { onError?: (err: Error) => void }) => {
        options?.onError?.(new Error('anchor'));
      },
    );
    mockParseProgressAnchorError.mockReturnValueOnce({
      code: 'progress_requires_anchor' as const,
      detail: 'Cannot record progress without a planned start date or sprint assignment.',
      suggested_action: 'set_planned_start' as const,
    });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('slider', { name: /Task progress/i });
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Set a Planned Start date (or assign a sprint) before recording progress.',
    );
  });

  it('does not call updateTask when the progress slider is released without a change', () => {
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    const input = screen.getByRole('slider', { name: /Task progress/i });
    // Blur without ever calling fireEvent.change → localProgress stays null.
    fireEvent.blur(input);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Milestone rollup (ADR-0074, issue #409)
// ---------------------------------------------------------------------------

describe('OverviewSection — milestone rollup', () => {
  it('renders the rolled-up percent + lock copy when milestoneRollup is present', () => {
    mockTasks.splice(0, mockTasks.length, {
      ...baseTask,
      isMilestone: true,
      progress: 0,
      milestoneRollup: {
        percent_complete: 73,
        rollup_basis: 'points',
        variance_days: 3,
        sprint_scope_changed: false,
        sprint_count: 1,
      },
    });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/73%/)).toBeInTheDocument();
    expect(screen.getByText(/by points/i)).toBeInTheDocument();
    expect(screen.getByText(/Progress rolls up from sprint/i)).toBeInTheDocument();
    expect(screen.getByText(/Progress \(sprint rollup\)/i)).toBeInTheDocument();
  });

  it('shows "across N sprints" copy + positive variance when multi-sprint slip', () => {
    mockTasks.splice(0, mockTasks.length, {
      ...baseTask,
      isMilestone: true,
      progress: 0,
      milestoneRollup: {
        percent_complete: 50,
        rollup_basis: 'points',
        variance_days: 8,
        sprint_scope_changed: false,
        sprint_count: 3,
      },
    });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByText(/across 3 sprints/i)).toBeInTheDocument();
    const variance = screen.getByText(/Sprint plan: \+8d slip/i);
    expect(variance.className).toMatch(/text-semantic-critical/);
  });

  it('shows the persistent "scope changed" chip when sprint_scope_changed is true (#550)', () => {
    mockTasks.splice(0, mockTasks.length, {
      ...baseTask,
      isMilestone: true,
      progress: 0,
      milestoneRollup: {
        percent_complete: 60,
        rollup_basis: 'points',
        variance_days: 0,
        sprint_scope_changed: true,
        scope_change_sprint_id: 'sp-active',
        sprint_count: 1,
      },
    });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    // Persistent, clickable chip replaces the former hover-only inline text.
    expect(screen.getByRole('button', { name: /Scope changed/i })).toBeInTheDocument();
  });

  it('falls back to editable input when basis is "none"', () => {
    mockTasks.splice(0, mockTasks.length, {
      ...baseTask,
      isMilestone: true,
      milestoneRollup: {
        percent_complete: null,
        rollup_basis: 'none',
        variance_days: null,
        sprint_scope_changed: false,
        sprint_count: 0,
      },
    });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    // Editable input still rendered — no rollup-driven lock when basis=none.
    expect(screen.getByRole('slider', { name: /Task progress/i })).toBeInTheDocument();
  });

  it('shows "by tasks" copy for throughput-basis rollup', () => {
    mockTasks.splice(0, mockTasks.length, {
      ...baseTask,
      isMilestone: true,
      progress: 0,
      milestoneRollup: {
        percent_complete: 65,
        rollup_basis: 'tasks',
        variance_days: null,
        sprint_scope_changed: false,
        sprint_count: 1,
      },
    });
    renderWithProviders(<OverviewSection taskId="t1" projectId="p1" />);
    expect(screen.getByText(/by tasks/i)).toBeInTheDocument();
  });
});
