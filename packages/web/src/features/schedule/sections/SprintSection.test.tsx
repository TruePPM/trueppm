import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { SprintSection } from './SprintSection';
import type { Task, ApiSprint } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

let mockSprints: ApiSprint[] = [];
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: mockSprints, isLoading: false, error: null }),
  useActiveSprint: () => ({ sprint: null }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
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
  sprintId: null,
};

const activeSprint: ApiSprint = {
  id: 'sprint-1',
  server_version: 1,
  short_id: 'SP-1',
  short_id_display: 'SP-1',
  name: 'Sprint 1',
  goal: '',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  wip_limit: null,
  committed_points: 8,
  committed_task_count: 1,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: null,
  completion_ratio_tasks: null,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const plannedSprint: ApiSprint = {
  ...activeSprint,
  id: 'sprint-2',
  name: 'Sprint 2',
  state: 'PLANNED',
  start_date: '2026-04-15',
  finish_date: '2026-04-28',
  activated_at: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SprintSection', () => {
  it('returns null when task is not found', () => {
    mockTasks.splice(0, mockTasks.length);
    mockSprints = [];
    const { container } = renderWithProviders(
      <SprintSection taskId="missing" projectId="p1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows empty-state message when no assignable sprints and task has no sprint', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    mockSprints = [];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByText(/No active or planned sprints/i)).toBeInTheDocument();
  });

  it('renders the sprint selector when assignable sprints exist', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('combobox', { name: /Sprint assignment/i })).toBeInTheDocument();
  });

  it('shows Active badge and dates when task is in an active sprint', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Date range appears in the tppm-mono badge span (not the option text)
    expect(screen.getAllByText(/2026-04-01/).length).toBeGreaterThan(0);
  });

  it('shows Remove button when task is assigned to a sprint', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByRole('button', { name: /Remove from sprint/i })).toBeInTheDocument();
  });

  it('shows Planned badge for a planned sprint', () => {
    mockTasks.splice(0, mockTasks.length, { ...baseTask, sprintId: 'sprint-2' });
    mockSprints = [plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Planned')).toBeInTheDocument();
  });

  it('does not show Remove button when task has no sprint', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('button', { name: /Remove from sprint/i })).not.toBeInTheDocument();
  });
});
