import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { EstimatesSection } from './EstimatesSection';
import type { Task, ApiSprint } from '@/types';
import type { UseMonteCarloResultReturn } from '@/hooks/useMonteCarloResult';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 100, isLoading: false }),
}));

let mockActiveSprint: ApiSprint | null = null;
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => ({ sprint: mockActiveSprint }),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    patch: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn(),
    // get is consumed by useVelocitySuggestions once a PM-role test fixture
    // lands; defensive default keeps the suite passing as roles widen.
    get: vi.fn().mockResolvedValue({ data: { count: 0, results: [] } }),
  },
}));

let mockMcReturn: UseMonteCarloResultReturn = { data: undefined, isLoading: false, error: null };
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => mockMcReturn,
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

// Summary task with no PERT on any descendant
const summaryTask: Task = { ...baseTask, id: 'phase-1', isSummary: true, parentId: null };
// Leaf child of summaryTask with no PERT
const childNoPert: Task = { ...baseTask, id: 'child-1', parentId: 'phase-1' };
// Leaf child of summaryTask with PERT set
const childWithPert: Task = {
  ...baseTask,
  id: 'child-2',
  parentId: 'phase-1',
  optimisticDuration: 3,
  mostLikelyDuration: 5,
  pessimisticDuration: 8,
};

const mcResult = {
  projectId: 'p1',
  runs: 1000,
  p50: '2026-09-15',
  p80: '2026-10-01',
  p95: '2026-10-20',
  buckets: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EstimatesSection', () => {
  it('returns null when task is not found', () => {
    mockTasks.splice(0, mockTasks.length);
    const { container } = renderWithProviders(<EstimatesSection taskId="missing" projectId="p1" />);
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

  describe('summary task routing (#403)', () => {
    it('hides the section entirely when a summary task has no descendant PERT', () => {
      mockTasks.splice(0, mockTasks.length, summaryTask, childNoPert);
      const { container } = renderWithProviders(
        <EstimatesSection taskId="phase-1" projectId="p1" />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('shows Run Monte Carlo hint when descendants have PERT but MC not run', () => {
      mockMcReturn = { data: undefined, isLoading: false, error: null };
      mockTasks.splice(0, mockTasks.length, summaryTask, childWithPert);
      renderWithProviders(<EstimatesSection taskId="phase-1" projectId="p1" />);
      expect(
        screen.getByText(/Run Monte Carlo to see phase confidence dates/i),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText(/Optimistic/i)).not.toBeInTheDocument();
    });

    it('shows Phase P50/P80/P95 chips when descendants have PERT and MC has been run', () => {
      mockMcReturn = { data: mcResult, isLoading: false, error: null };
      mockTasks.splice(0, mockTasks.length, summaryTask, childWithPert);
      renderWithProviders(<EstimatesSection taskId="phase-1" projectId="p1" />);
      expect(screen.getByText(/Phase P50/)).toBeInTheDocument();
      expect(screen.getByText(/Phase P80/)).toBeInTheDocument();
      expect(screen.getByText(/Phase P95/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Optimistic/i)).not.toBeInTheDocument();
    });

    it('detects PERT on a grandchild (multi-level summary)', () => {
      const grandchild: Task = {
        ...baseTask,
        id: 'gc-1',
        parentId: 'child-1',
        optimisticDuration: 2,
      };
      mockMcReturn = { data: mcResult, isLoading: false, error: null };
      mockTasks.splice(0, mockTasks.length, summaryTask, childNoPert, grandchild);
      renderWithProviders(<EstimatesSection taskId="phase-1" projectId="p1" />);
      expect(screen.getByText(/Phase P50/)).toBeInTheDocument();
    });

    it('does not affect leaf tasks — they still render editable fields', () => {
      mockTasks.splice(0, mockTasks.length, baseTask);
      renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);
      expect(screen.getByLabelText(/Optimistic/i)).toBeInTheDocument();
    });
  });
});
