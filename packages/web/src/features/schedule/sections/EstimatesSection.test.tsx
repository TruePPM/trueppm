import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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

let mockActiveSprint: ApiSprint | null = null;
let mockSprintsLoading = false;
let mockSprintsError: Error | null = null;
const mockRefetchSprints = vi.fn();
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => ({
    sprint: mockActiveSprint,
    isLoading: mockSprintsLoading,
    error: mockSprintsError,
    refetch: mockRefetchSprints,
  }),
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
  cpmFinish: null,
  deltaVsCpm: { p50: null, p80: null, p95: null },
  confidenceCurve: [],
  sensitivity: [],
  forecastStaleness: 'current' as const,
  planVersion: 1,
  planVersionCurrent: 1,
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

  // -------------------------------------------------------------------------
  // Unresolved sprint read (#3455, rule 392)
  //
  // `activeSprint === null` means BOTH "not in the active sprint" and "we could
  // not find out". The control is withheld in both cases (fail-closed, rule
  // 379); what must differ is what it says about itself. These four pin the
  // polarity pair — resolved-not-active vs failed — against each other so a
  // later "make these consistent" refactor has to confront the asymmetry.
  // -------------------------------------------------------------------------
  describe('unresolved sprint read (#3455)', () => {
    beforeEach(() => {
      mockActiveSprint = null;
      mockSprintsLoading = false;
      mockSprintsError = null;
      mockRefetchSprints.mockClear();
    });

    afterEach(() => {
      mockActiveSprint = null;
      mockSprintsLoading = false;
      mockSprintsError = null;
    });

    it('keeps remaining points disabled and explains the failure when the sprint read failed', () => {
      mockTasks.splice(0, mockTasks.length, sprintTask);
      mockSprintsError = new Error('sprints unavailable');
      renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);

      expect(screen.getByLabelText(/Remaining \(pts\)/i)).toBeDisabled();
      expect(screen.getByText(/Couldn't check whether the sprint is active/i)).toBeInTheDocument();
      // The false all-clear must be GONE — it reads as a fact about the sprint.
      expect(
        screen.queryByText(/Remaining effort can be updated while the sprint is active/i),
      ).not.toBeInTheDocument();
    });

    it('retries just the sprint read from the failure copy', () => {
      mockTasks.splice(0, mockTasks.length, sprintTask);
      mockSprintsError = new Error('sprints unavailable');
      renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);

      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
      expect(mockRefetchSprints).toHaveBeenCalledTimes(1);
    });

    it('stays quiet while the sprint read is still in flight', () => {
      mockTasks.splice(0, mockTasks.length, sprintTask);
      mockSprintsLoading = true;
      renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);

      expect(screen.getByLabelText(/Remaining \(pts\)/i)).toBeDisabled();
      // Neither claim is available yet: no failure notice, and no "…while the
      // sprint is active", which would assert the sprint is NOT active.
      expect(
        screen.queryByText(/Couldn't check whether the sprint is active/i),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Remaining effort can be updated while the sprint is active/i),
      ).not.toBeInTheDocument();
    });

    it('still shows the plain not-active copy once the read RESOLVES with no active sprint', () => {
      // The other half of the polarity pair: same disabled control, but here the
      // read answered, so naming the sprint state is a fact and not a guess.
      mockTasks.splice(0, mockTasks.length, sprintTask);
      renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);

      expect(screen.getByLabelText(/Remaining \(pts\)/i)).toBeDisabled();
      expect(
        screen.getByText(/Remaining effort can be updated while the sprint is active/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Couldn't check whether the sprint is active/i),
      ).not.toBeInTheDocument();
    });

    it('does not treat a sprint-LESS task as unknown when the read fails', () => {
      // A task with no sprintId has nothing to look up, so the fieldset does not
      // render at all — an unscoped `isLoading || error` would have made every
      // backlog task "unknown" (rule 392: scope the unknown to the lookup).
      mockTasks.splice(0, mockTasks.length, baseTask);
      mockSprintsError = new Error('sprints unavailable');
      renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" />);

      expect(screen.queryByLabelText(/Remaining \(pts\)/i)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Couldn't check whether the sprint is active/i),
      ).not.toBeInTheDocument();
    });
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
