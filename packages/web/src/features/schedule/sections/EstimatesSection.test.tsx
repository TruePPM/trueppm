import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { EstimatesSection } from './EstimatesSection';
import type { Task, ApiSprint } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 1 }),
}));

let mockActiveSprint: ApiSprint | null = null;
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => ({ sprint: mockActiveSprint }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() },
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
};

const sprintTask: Task = {
  ...baseTask,
  sprintId: 'sprint-1',
  storyPoints: 8,
  remainingPoints: 5,
};

const activeSprint: ApiSprint = {
  id: 'sprint-1',
  server_version: 1,
  short_id: 'SP-A1B2',
  short_id_display: 'SP-A1B2',
  name: 'Sprint 1',
  goal: '',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EstimatesSection', () => {
  it('returns null when task is not found', () => {
    mockTasks.splice(0, mockTasks.length);
    const { container } = renderWithProviders(
      <EstimatesSection taskId="missing" projectId="p1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders EstimatesTab when task is found', () => {
    mockTasks.splice(0, mockTasks.length, baseTask);
    renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);
    expect(screen.getByLabelText(/Optimistic/i)).toBeInTheDocument();
  });

  it('passes sprintIsActive=true when activeSprint matches task sprint', () => {
    mockTasks.splice(0, mockTasks.length, sprintTask);
    mockActiveSprint = activeSprint;
    renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);
    expect(screen.getByLabelText(/Remaining \(pts\)/i)).not.toBeDisabled();
    mockActiveSprint = null;
  });

  it('passes sprintIsActive=false when activeSprint does not match task sprint', () => {
    mockTasks.splice(0, mockTasks.length, sprintTask);
    mockActiveSprint = { ...activeSprint, id: 'sprint-999' };
    renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);
    expect(screen.getByLabelText(/Remaining \(pts\)/i)).toBeDisabled();
    mockActiveSprint = null;
  });
});
