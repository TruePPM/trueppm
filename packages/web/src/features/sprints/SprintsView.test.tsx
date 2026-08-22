import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { SprintsView } from './SprintsView';
import { makeSprint } from './sprintTestFixtures';
import { ROLE_ADMIN, ROLE_SCHEDULER, ROLE_VIEWER } from '@/lib/roles';
import type { MyActiveSprintEntry } from '@/hooks/useMyActiveSprints';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';
import type { ProjectVelocity, SprintCapacity } from '@/hooks/useSprints';
import type { ApiSprint, Task } from '@/types';

const projectIdMock = vi.fn<() => string | undefined>(() => 'proj-1');
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => projectIdMock(),
}));

interface ProjectQueryResult {
  data:
    | { id: string; name: string; methodology: string; effective_methodology?: string }
    | undefined;
  isLoading: boolean;
  error: unknown;
}
const useProjectMock = vi.fn<() => ProjectQueryResult>(() => ({
  data: { id: 'proj-1', name: 'Alpha Platform', methodology: 'AGILE' },
  isLoading: false,
  error: null,
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProjectMock(),
}));

const useSprintsMock = vi.fn<(projectId?: string | null) => unknown>();
const useSprintsByStateMock = vi.fn<(projectId?: string | null) => unknown>();
const useSprintMutationsMock = vi.fn<(projectId?: string | null) => unknown>(() => ({
  closeSprint: { mutate: vi.fn() },
  createSprint: { mutate: vi.fn() },
  activateSprint: { mutate: vi.fn() },
  // ExcludeFromVelocityToggle (ADR-0113) reads updateSprint.{mutate,isPending}.
  updateSprint: { mutate: vi.fn(), isPending: false },
}));

/** Per-sprint capacity read — keyed by sprint id so the ACTIVE and PLANNED
 *  surfaces can be given different payloads in the same render. */
const useSprintCapacityMock = vi.fn<
  (sprintId?: string | null) => { data: SprintCapacity | undefined }
>(() => ({ data: undefined }));
const useProjectVelocityMock = vi.fn<() => { data: ProjectVelocity | undefined }>(() => ({
  data: undefined,
}));
const useSprintOutcomeMock = vi.fn<() => { data: unknown }>(() => ({ data: undefined }));

vi.mock('@/hooks/useSprints', () => ({
  useSprints: (projectId?: string | null) => useSprintsMock(projectId),
  useSprintsByState: (projectId?: string | null) => useSprintsByStateMock(projectId),
  useSprintMutations: (projectId?: string | null) => useSprintMutationsMock(projectId),
  useSprintBurndown: () => ({ data: undefined, isLoading: false, error: null }),
  useSprintCapacity: (sprintId?: string | null) => useSprintCapacityMock(sprintId),
  useProjectVelocity: () => useProjectVelocityMock(),
  // #988: GuardrailHealthBadges renders server-owned signals; default to empty.
  useSprintHealth: () => ({ data: { signals: [] }, isLoading: false, error: null }),
  useSprintOutcome: () => useSprintOutcomeMock(),
  useSprintDailyDelta: () => ({ data: undefined, isLoading: false, error: null }),
  useSprintRetro: () => ({ data: null, isLoading: false, error: null }),
  useSprintRetroPrior: () => ({ data: null, isLoading: false, error: null }),
  useSaveSprintRetro: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
  useUpdateRetroVisibility: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
  usePromoteRetroActionItem: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
  isFullRetro: (payload: { kind?: string } | null | undefined) =>
    !!payload && payload.kind === 'full',
  // The remaining useSprints exports exercised by the deeper surfaces (PLANNED
  // carryover lane, CLOSED outcome curation, scope review). Safe read/no-op
  // defaults so those child components render without a live API.
  useActiveSprint: () => ({ data: null, isLoading: false, error: null }),
  useIncomingCarryover: () => ({ data: undefined, isLoading: false, error: null }),
  useSprintScopeChanges: () => ({ data: undefined, isLoading: false, error: null }),
  useSprintDurationChanges: () => ({ data: undefined, isLoading: false, error: null }),
  useProjectForecast: () => ({ data: undefined, isLoading: false, error: null }),
  useSprintForecast: () => ({ data: undefined, isLoading: false, error: null }),
  useFlowMetrics: () => ({ data: undefined, isLoading: false, error: null }),
  // CarryoverLane: data.length === 0 (undefined) → renders nothing.
  useProjectRetroCarryover: () => ({ data: undefined, isLoading: false, error: null }),
  usePullCarryoverToSprint: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleDemo: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderDemoList: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPresenter: () => ({ mutate: vi.fn(), isPending: false }),
  useSetReviewNote: () => ({ mutate: vi.fn(), isPending: false }),
  useFlagForBacklog: () => ({ mutate: vi.fn(), isPending: false }),
  useAcceptSuggestion: () => ({ mutate: vi.fn(), isPending: false }),
  useDeclineSuggestion: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeSuggestion: () => ({ mutate: vi.fn(), isPending: false }),
  // #2968 — GenerateCadenceModal reads both of these. It only mounts when the
  // wizard is opened, so a missing entry here does not fail today; the first
  // test that clicks "Generate sprints" would get a bare "No export is defined
  // on the mock" instead of a useful failure.
  useGenerateSprints: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  MAX_GENERATED_SPRINTS: 52,
}));

const useMyActiveSprintsMock = vi.fn(() => ({
  data: [] as Array<{ project_id: string; project_name: string }> | undefined,
  isLoading: false,
  error: null,
}));

vi.mock('@/hooks/useMyActiveSprints', () => ({
  useMyActiveSprints: () => useMyActiveSprintsMock(),
}));

// Per-sprint backlog read. Keyed by sprint id so the ACTIVE and PLANNED
// surfaces can be driven independently; defaults to "not loaded yet".
const useSprintBacklogMock = vi.fn<
  (projectId?: string | null, sprintId?: string | null) => { data: SprintBacklogTask[] | undefined }
>(() => ({ data: undefined }));
vi.mock('@/hooks/useSprintBacklog', () => ({
  useSprintBacklog: (projectId?: string | null, sprintId?: string | null) =>
    useSprintBacklogMock(projectId, sprintId),
}));

// Project-wide task list — feeds the drawer round-trip and the CLOSED reforecast.
const useScheduleTasksMock = vi.fn<() => { tasks: Task[] | undefined }>(() => ({
  tasks: undefined,
}));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => useScheduleTasksMock(),
}));

const resourceIdMock = vi.fn<() => string | null>(() => null);
vi.mock('@/hooks/useCurrentUserResourceId', () => ({
  useCurrentUserResourceId: () => ({ resourceId: resourceIdMock(), isLoading: false }),
}));

// Goal-edit gate (#1095 / ADR-0078) — distinct from useCanManageScope.
const canEditGoalMock = vi.fn<() => boolean>(() => false);
vi.mock('@/hooks/useCanEditSprintGoal', () => ({
  useCanEditSprintGoal: () => canEditGoalMock(),
}));

// Remove-from-sprint routes through useUpdateTask; the rest of the module stays
// real so nothing else in the tree loses its behavior.
type UpdateTaskCallbacks = { onSuccess?: () => void; onError?: (error: unknown) => void };
const updateTaskMutate =
  vi.fn<(vars: Record<string, unknown>, opts?: UpdateTaskCallbacks) => void>();
vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useUpdateTask: () => ({ mutate: updateTaskMutate, isPending: false }),
  };
});

// Toast is called imperatively from mutation callbacks (close success/error,
// #1470/#1631); spy on it so we can assert what the closer sees.
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/components/Toast/toast', () => ({
  toast: {
    success: toastMocks.success,
    error: toastMocks.error,
    info: toastMocks.info,
    warm: vi.fn(),
    action: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Render-gate for scope-review + empty-state CTA (ADR-0102 §3). Default denied.
const canManageScopeMock = vi.fn(() => false);
vi.mock('@/hooks/useCanManageScope', () => ({
  useCanManageScope: () => canManageScopeMock(),
}));

// Sprint lifecycle gate (#2146) — default to SCHEDULER so the Plan/Activate/Close
// assertions apply; the role-gating test overrides it to VIEWER.
const currentRoleMock = vi.fn<() => number | null>(() => ROLE_SCHEDULER);
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: currentRoleMock(), roleLabel: null, isLoading: false }),
}));

// The task create modal + detail drawer are heavy board/schedule surfaces with
// their own deep test suites; stub them to lightweight props-echoing shims so we
// can assert SprintsView opens them with the right target without a live API.
vi.mock('@/features/board/TaskFormModal', () => ({
  TaskFormModal: ({
    defaultSprintId,
    onClose,
  }: {
    defaultSprintId: string;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Add task">
      <span>target:{defaultSprintId}</span>
      <button type="button" onClick={onClose}>
        Close add task
      </button>
    </div>
  ),
}));
vi.mock('@/features/schedule/TaskDetailDrawer', () => ({
  TaskDetailDrawer: ({
    task,
    onClose,
    onSwapCanceled,
  }: {
    task: { id: string; name: string } | null;
    onClose: () => void;
    onSwapCanceled?: (keptId: string) => void;
  }) => (
    <div role="dialog" aria-label="Task detail">
      <span>resolved:{task ? task.name : 'unresolved'}</span>
      <button type="button" onClick={onClose}>
        Close task drawer
      </button>
      <button type="button" onClick={() => onSwapCanceled?.('task-2')}>
        Keep the current task
      </button>
    </div>
  ),
}));

/** A fully-shaped My-Teams lens entry so MultiTeamLens can render a real card. */
function makeTeamEntry(id: string, name: string): MyActiveSprintEntry {
  return {
    project_id: id,
    project_name: name,
    sprint: {
      id: `${id}-s`,
      name: `${name} sprint`,
      short_id_display: 'SP-9Z9Z',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
      day: 3,
      total: 14,
      remaining_points: 8,
      committed_points: 20,
      trend_pts: 2,
    },
    capacity_ratio: 0.8,
    capacity_label: 'on_track',
    velocity: {
      rolling_avg_points: 18,
      forecast_range_low: 16,
      forecast_range_high: 22,
      velocity_suppressed: false,
    },
  };
}

const ACTIVE = makeSprint({
  id: 'sp-active',
  state: 'ACTIVE',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware',
  committed_points: 47,
});

describe('SprintsView', () => {
  it('renders breadcrumb and active sprint header on success', () => {
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(screen.getByLabelText(/Breadcrumb/i)).toHaveTextContent(/Alpha Platform/);
    expect(screen.getByLabelText(/Breadcrumb/i)).toHaveTextContent(/Sprints/);
    expect(
      screen.getByRole('heading', { level: 1, name: /Sprint 1 — Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('renders loading state', () => {
    useSprintsMock.mockReturnValue({ sprints: [], isLoading: true, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [],
      isLoading: true,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    expect(screen.getByRole('status', { name: /Loading sprints/i })).toBeInTheDocument();
  });

  it('renders error state', () => {
    useSprintsMock.mockReturnValue({
      sprints: [],
      isLoading: false,
      error: new Error('boom'),
    });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [],
      isLoading: false,
      error: new Error('boom'),
    });
    renderWithRouter(<SprintsView />);
    // Shared QueryErrorState (inline variant → role="status") replaces the raw
    // error.message leak; a real Retry sits alongside the message (#1937).
    expect(screen.getByText(/Couldn't load sprints/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('renders empty state when no sprints exist', () => {
    useSprintsMock.mockReturnValue({ sprints: [], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    expect(screen.getByText(/No sprints yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Plan your first sprint/i)).toBeInTheDocument();
  });

  // #2619: a WATERFALL project hides this route from the nav, but the route
  // stays reachable by direct URL — the bug was the cold-start CTA inviting the
  // deviation the preset exists to discourage.
  describe('on a WATERFALL project (#2619)', () => {
    // Scoped to this block: the file's default `useProjectMock` fixture is
    // AGILE, and nothing else in this suite resets it between tests.
    afterEach(() => {
      useProjectMock.mockReturnValue({
        data: { id: 'proj-1', name: 'Alpha Platform', methodology: 'AGILE' },
        isLoading: false,
        error: null,
      });
    });

    it('shows the methodology-mismatch empty state with no sprints', () => {
      useProjectMock.mockReturnValue({
        data: {
          id: 'proj-1',
          name: 'Alpha Platform',
          methodology: 'WATERFALL',
          effective_methodology: 'WATERFALL',
        },
        isLoading: false,
        error: null,
      });
      useSprintsMock.mockReturnValue({ sprints: [], isLoading: false, error: null });
      useSprintsByStateMock.mockReturnValue({
        closed: [],
        active: null,
        planned: [],
        isLoading: false,
        error: null,
      });
      renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

      expect(screen.getByText(/aren't part of this project's workflow/i)).toBeInTheDocument();
      expect(screen.queryByText(/No sprints yet/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Plan a sprint/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go to Schedule' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
    });

    // Flipping to WATERFALL never touches sprint data, so existing sprints must
    // stay visible with an explanation rather than being swallowed by an
    // (incorrect) "No sprints yet" empty state.
    it('renders existing sprints with a mismatch banner', () => {
      useProjectMock.mockReturnValue({
        data: {
          id: 'proj-1',
          name: 'Alpha Platform',
          methodology: 'WATERFALL',
          effective_methodology: 'WATERFALL',
        },
        isLoading: false,
        error: null,
      });
      useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
      useSprintsByStateMock.mockReturnValue({
        closed: [],
        active: ACTIVE,
        planned: [],
        isLoading: false,
        error: null,
      });
      renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

      expect(
        screen.getByText(
          /This project is configured as Waterfall, but 1 sprint already is committed/i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Review methodology' })).toBeInTheDocument();
      // The sprint itself still renders — the mismatch is a banner, not a swap.
      expect(
        screen.getByRole('heading', { level: 1, name: /Sprint 1 — Telemetry & FAT prep/ }),
      ).toBeInTheDocument();
    });
  });

  it('disables Plan next button when a planned sprint already exists', () => {
    const PLANNED = makeSprint({ id: 'sp-planned', state: 'PLANNED' });
    useSprintsMock.mockReturnValue({
      sprints: [ACTIVE, PLANNED],
      isLoading: false,
      error: null,
    });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [PLANNED],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    expect(
      screen.getByRole('button', {
        name: /Plan next sprint \(a planned sprint already exists\)/i,
      }),
    ).toBeDisabled();
  });

  it('does not render the My Teams toggle when user has < 2 active sprints', () => {
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    useMyActiveSprintsMock.mockReturnValue({
      data: [{ project_id: 'p1', project_name: 'Alpha' }],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    expect(screen.queryByRole('radiogroup', { name: /Sprint scope/i })).not.toBeInTheDocument();
  });

  it('opens the Plan sprint modal when Plan next sprint is clicked', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    // Match the header button (exact label) — the timeline's "+ Plan next sprint" slot
    // has a different accessible name and shouldn't be the trigger under test.
    await userEvent.click(screen.getByRole('button', { name: /^Plan next sprint$/i }));
    expect(screen.getByRole('dialog', { name: /Plan next sprint/i })).toBeInTheDocument();
  });

  it('renders the My Teams toggle when user has 2+ active sprints', () => {
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    useMyActiveSprintsMock.mockReturnValue({
      data: [
        { project_id: 'p1', project_name: 'Alpha' },
        { project_id: 'p2', project_name: 'Beta' },
      ],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    // Scope switcher is a segmented radiogroup (web-rule 179/167), not a tablist (#2204).
    expect(screen.getByRole('radiogroup', { name: /Sprint scope/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /My Teams \(2\)/i })).toBeInTheDocument();
  });
});

const PLANNED = makeSprint({
  id: 'sp-planned',
  state: 'PLANNED',
  name: 'Next up',
  start_date: '2026-04-15',
  finish_date: '2026-04-28',
});

const PLANNED_FAR = makeSprint({
  id: 'sp-planned-far',
  state: 'PLANNED',
  name: 'Way ahead',
  // Far enough from "now" that the timeline shows Edit, not Activate.
  start_date: '2027-01-01',
  finish_date: '2027-01-14',
});

const CLOSED = makeSprint({
  id: 'sp-closed',
  state: 'COMPLETED',
  name: 'Sprint zero',
  start_date: '2026-03-01',
  finish_date: '2026-03-14',
});

describe('SprintsView — surfaces, lifecycle, and gates', () => {
  beforeEach(() => {
    toastMocks.success.mockClear();
    toastMocks.error.mockClear();
    toastMocks.info.mockClear();
    window.sessionStorage.clear();
    canManageScopeMock.mockReturnValue(false);
    currentRoleMock.mockReturnValue(ROLE_SCHEDULER);
    useMyActiveSprintsMock.mockReturnValue({ data: [], isLoading: false, error: null });
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
  });

  it('swaps the sprint header for the My Teams lens when the scope radio is toggled', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    useMyActiveSprintsMock.mockReturnValue({
      data: [makeTeamEntry('p1', 'Alpha'), makeTeamEntry('p2', 'Beta')],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    // Project scope (default): the active-sprint H1 is shown.
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /My Teams \(2\)/i }));

    // Teams scope replaces the header/body with the cross-project lens.
    expect(
      screen.queryByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^My Teams$/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /My Teams/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Each team renders a card linking to that project's sprint.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    // Switching back restores the sprint header.
    await userEvent.click(screen.getByRole('radio', { name: /This project/i }));
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('scope radiogroup: ArrowRight moves focus and commits the selection (web-rule 179)', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    useMyActiveSprintsMock.mockReturnValue({
      data: [makeTeamEntry('p1', 'Alpha'), makeTeamEntry('p2', 'Beta')],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    const projectRadio = screen.getByRole('radio', { name: /This project/i });
    // Roving tabindex: only the selected radio is tabbable.
    expect(projectRadio).toHaveAttribute('tabindex', '0');
    projectRadio.focus();

    // ArrowRight moves focus to the Teams radio AND commits it (the scope swap is
    // non-destructive, so arrow navigation applies immediately).
    await userEvent.keyboard('{ArrowRight}');
    const teamsRadio = screen.getByRole('radio', { name: /My Teams \(2\)/i });
    expect(teamsRadio).toHaveFocus();
    expect(teamsRadio).toHaveAttribute('aria-checked', 'true');
    expect(teamsRadio).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('heading', { name: /^My Teams$/i })).toBeInTheDocument();
  });

  it('renders the planning-bridge surface for a PLANNED selection', () => {
    useSprintsMock.mockReturnValue({ sprints: [PLANNED], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [PLANNED],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    // Default selection falls back to the next planned sprint → planning bridge.
    expect(screen.getByRole('heading', { name: /Planning bridge/i })).toBeInTheDocument();
    // No active sprint → the header advertises the empty active slot.
    expect(screen.getByRole('heading', { level: 1, name: /No sprint yet/i })).toBeInTheDocument();
  });

  it('renders the closed-outcome skeleton for a COMPLETED selection via ?sprint=', () => {
    // Active sprint exists, but the deep-link pins the selection to the closed one,
    // proving ?sprint= overrides the active→planned→closed fallback.
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE, CLOSED], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [CLOSED],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-closed'],
    });
    // outcomeQuery.data is undefined in the mock → the outcome skeleton renders.
    expect(screen.getByRole('status', { name: /Loading Sprint outcome/i })).toBeInTheDocument();
    // The active sprint still owns the header even though a closed one is selected.
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('opens the filter popover on the first Filter click and closes it on the second', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(
      screen.queryByRole('dialog', { name: /Filter sprint backlog/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(screen.getByRole('dialog', { name: /Filter sprint backlog/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(
      screen.queryByRole('dialog', { name: /Filter sprint backlog/i }),
    ).not.toBeInTheDocument();
  });

  it('closes the active sprint, confirms with a toast + retro handoff, then clears the banner on Run', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn((_vars: unknown, opts: { onSuccess?: () => void }) =>
      opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintsMock.mockReturnValue({
      sprints: [ACTIVE, PLANNED],
      isLoading: false,
      error: null,
    });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [PLANNED],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    // Open the close dialog from the header, then confirm.
    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    expect(screen.getByRole('dialog', { name: /Close/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));

    expect(closeMutate).toHaveBeenCalledTimes(1);
    // Empty backlog → carriedCount 0 → the plain "closed." confirmation copy.
    expect(toastMocks.success).toHaveBeenCalledWith(
      expect.stringMatching(/Telemetry & FAT prep closed\./),
    );
    // Dialog closes only on success.
    expect(screen.queryByRole('dialog', { name: /Close/i })).not.toBeInTheDocument();
    // The retro handoff banner appears with a one-tap jump into the retro.
    const runRetro = screen.getByRole('button', {
      name: /Run the Telemetry & FAT prep retro/i,
    });
    expect(runRetro).toBeInTheDocument();

    // Running the retro clears the handoff banner.
    await userEvent.click(runRetro);
    expect(
      screen.queryByRole('button', { name: /Run the Telemetry & FAT prep retro/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the dialog logic when close fails', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn((_vars: unknown, opts: { onError?: () => void }) => opts.onError?.());
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));

    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringMatching(/Couldn't close the sprint/i),
    );
    // No success → no retro handoff banner.
    expect(screen.queryByRole('button', { name: /Run the .* retro/i })).not.toBeInTheDocument();
  });

  // #2146 — lifecycle writes are SCHEDULER+. A Viewer sees the sprint data but
  // no Plan/Close/Activate chrome (previously all rendered and 403'd on click).
  it('hides Plan/Close/Activate lifecycle controls for a Viewer', () => {
    currentRoleMock.mockReturnValue(ROLE_VIEWER);
    const readyPlanned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
    });
    useSprintsMock.mockReturnValue({
      sprints: [ACTIVE, readyPlanned],
      isLoading: false,
      error: null,
    });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [readyPlanned],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(screen.queryByRole('button', { name: /Close active sprint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Plan next sprint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    // The header still renders — read access is unaffected.
    expect(
      screen.getByRole('heading', { level: 1, name: /Sprint 1 — Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('surfaces capacity warnings after activating a planned sprint and dismisses them', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const activateMutate = vi.fn((_id: string, opts: { onSuccess?: (data: unknown) => void }) =>
      opts.onSuccess?.({
        warnings: [{ resource_id: 'r1', message: 'Alice is overallocated' }],
      }),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: activateMutate },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    // Past start_date → the timeline card is ready-to-activate.
    useSprintsMock.mockReturnValue({ sprints: [PLANNED], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [PLANNED],
      isLoading: false,
      error: null,
    });
    // PLANNED default start_date is in the past → force ready-to-activate.
    const readyPlanned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
    });
    useSprintsMock.mockReturnValue({ sprints: [readyPlanned], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [readyPlanned],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Activate/i }));
    expect(activateMutate).toHaveBeenCalledWith('sp-planned', expect.any(Object));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Sprint activated with 1 capacity warning/i);
    expect(alert).toHaveTextContent(/Alice is overallocated/);

    await userEvent.click(screen.getByRole('button', { name: /^Dismiss$/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('toasts the server reason when activating a sprint fails (#2150)', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    // The activate mutate rejects with a DRF 409 body (single-active-sprint rule).
    const activateMutate = vi.fn((_id: string, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.({
        isAxiosError: true,
        response: { status: 409, data: { detail: 'Another sprint is already active.' } },
      }),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: activateMutate },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    const readyPlanned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
    });
    useSprintsMock.mockReturnValue({ sprints: [readyPlanned], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [readyPlanned],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Activate/i }));
    // The server's own reason is surfaced, not a generic fallback.
    expect(toastMocks.error).toHaveBeenCalledWith('Another sprint is already active.');
  });

  it('opens the edit modal from the timeline Edit action on a far-future planned sprint', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [PLANNED_FAR], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [PLANNED_FAR],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    expect(screen.getByRole('dialog', { name: /Edit planned sprint/i })).toBeInTheDocument();
  });

  it('gates the scope "Review pending" button on manage-scope permission', () => {
    const pendingSprint = makeSprint({
      id: 'sp-active',
      state: 'ACTIVE',
      name: 'Pending scope',
      pending_count: 2,
    });
    useSprintsMock.mockReturnValue({ sprints: [pendingSprint], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: pendingSprint,
      planned: [],
      isLoading: false,
      error: null,
    });

    // Denied: pending items exist but the user can't manage scope → no button.
    canManageScopeMock.mockReturnValue(false);
    const { unmount } = renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints'],
    });
    expect(screen.queryByRole('button', { name: /Review pending/i })).not.toBeInTheDocument();
    unmount();

    // Allowed: same pending count, manage-scope granted → the review button shows.
    canManageScopeMock.mockReturnValue(true);
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(screen.getByRole('button', { name: /Review pending \(2\)/i })).toBeInTheDocument();
  });

  it('offers a Plan CTA in the empty state only when the user can manage scope', () => {
    useSprintsMock.mockReturnValue({ sprints: [], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [],
      isLoading: false,
      error: null,
    });

    canManageScopeMock.mockReturnValue(false);
    const { unmount } = renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints'],
    });
    expect(screen.getByText(/No sprints yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Plan a sprint/i })).not.toBeInTheDocument();
    unmount();

    canManageScopeMock.mockReturnValue(true);
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(screen.getByRole('button', { name: /Plan a sprint/i })).toBeInTheDocument();
  });

  it('hydrates the backlog filter from sessionStorage and persists status toggles', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    // Seed a stored filter for the active sprint before mount → the hydrate
    // effect reads it and the popover reflects the persisted status.
    window.sessionStorage.setItem(
      'trueppm.sprintFilter.sp-active',
      JSON.stringify({ assignee: 'me', statuses: ['IN_PROGRESS'] }),
    );
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    // The stored IN_PROGRESS status shows as pressed; a different one does not.
    expect(screen.getByRole('button', { name: /In Progress/i, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Backlog$/i, pressed: false })).toBeInTheDocument();

    // Toggling another status persists the merged set back to sessionStorage.
    await userEvent.click(screen.getByRole('button', { name: /^Backlog$/i }));
    const persisted = JSON.parse(
      window.sessionStorage.getItem('trueppm.sprintFilter.sp-active') ?? '{}',
    ) as { statuses: string[] };
    expect(persisted.statuses).toEqual(expect.arrayContaining(['IN_PROGRESS', 'BACKLOG']));
  });

  it('opens the add-task modal targeting the active sprint on the "c" shortcut', () => {
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(screen.queryByRole('dialog', { name: /Add task/i })).not.toBeInTheDocument();
    // #2162: the add-task shortcut is the bare "c" key — it was moved off ⌘K to
    // stop colliding with the global command palette.
    fireEvent.keyDown(document, { key: 'c' });

    const modal = screen.getByRole('dialog', { name: /Add task/i });
    expect(modal).toBeInTheDocument();
    // The shortcut pre-targets the active sprint.
    expect(modal).toHaveTextContent('target:sp-active');
  });

  it('falls back to the planned sprint for the "c" shortcut when there is no active sprint', () => {
    useSprintsMock.mockReturnValue({ sprints: [PLANNED], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [PLANNED],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    fireEvent.keyDown(document, { key: 'c' });
    expect(screen.getByRole('dialog', { name: /Add task/i })).toHaveTextContent(
      'target:sp-planned',
    );
  });

  it('truncates the capacity-warning list to three with an overflow note, then dismisses', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const activateMutate = vi.fn((_id: string, opts: { onSuccess?: (data: unknown) => void }) =>
      opts.onSuccess?.({
        warnings: [
          { resource_id: 'r1', message: 'Alice overallocated' },
          { resource_id: 'r2', message: 'Bob overallocated' },
          { resource_id: 'r3', message: 'Cara overallocated' },
          { resource_id: 'r4', message: 'Dan overallocated' },
        ],
      }),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: activateMutate },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    const readyPlanned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
    });
    useSprintsMock.mockReturnValue({ sprints: [readyPlanned], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: null,
      planned: [readyPlanned],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Activate/i }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/activated with 4 capacity warnings/i);
    // Only the first three are listed; the rest collapse into an overflow note.
    expect(alert).toHaveTextContent(/Alice overallocated/);
    expect(alert).toHaveTextContent(/Cara overallocated/);
    expect(alert).not.toHaveTextContent(/Dan overallocated/);
    expect(alert).toHaveTextContent(/and 1 more/i);

    await userEvent.click(screen.getByRole('button', { name: /^Dismiss$/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dismisses the retro handoff banner without opening the retro', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn((_vars: unknown, opts: { onSuccess?: () => void }) =>
      opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [],
      active: ACTIVE,
      planned: [],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));
    expect(screen.getByRole('button', { name: /Dismiss retro handoff/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Dismiss retro handoff/i }));
    expect(
      screen.queryByRole('button', { name: /Dismiss retro handoff/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Guards, gates, and overlays — the branches the happy-path suite above never
// reaches: malformed persisted state, absent project/role context, the
// backlog write paths, and every overlay's dismiss affordance.
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT = { id: 'proj-1', name: 'Alpha Platform', methodology: 'AGILE' };

function makeBacklogTask(overrides: Partial<SprintBacklogTask> = {}): SprintBacklogTask {
  return {
    id: 'task-1',
    short_id: 'T-0001',
    name: 'Wire the telemetry probe',
    wbs_path: '1.1',
    status: 'IN_PROGRESS',
    story_points: 5,
    is_critical: false,
    assignments: [],
    ...overrides,
  };
}

function makeProjectTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    wbs: '1.1',
    name: 'Wire the telemetry probe',
    start: '2026-04-02',
    finish: '2026-04-06',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

/**
 * Three rows for the draft-load math (#864): an unassigned 5-pointer (excluded),
 * an assigned 3-pointer (counted), and an assigned but unestimated row (counts 0).
 */
const BACKLOG_ROWS: SprintBacklogTask[] = [
  makeBacklogTask(),
  makeBacklogTask({
    id: 'task-2',
    short_id: 'T-0002',
    name: 'Second task',
    status: 'BACKLOG',
    story_points: 3,
    assignments: [{ resource_id: 'r1', resource_name: 'Alice Ng', units: 1 }],
  }),
  makeBacklogTask({
    id: 'task-3',
    short_id: 'T-0003',
    name: 'Third task',
    status: 'REVIEW',
    story_points: null,
    assignments: [{ resource_id: 'r1', resource_name: 'Alice Ng', units: 1 }],
  }),
];

const CAPACITY_DATA: SprintCapacity = {
  members: [
    {
      member_id: 'r1',
      member_name: 'Alice Ng',
      initials: 'AN',
      committed_hours: 30,
      available_hours: 40,
      ratio: 0.75,
      is_over: false,
    },
  ],
  totals: {
    committed_hours: 30,
    available_hours: 40,
    ratio: 0.75,
    buffer_hours: 10,
    label: 'on_track',
    pto_days: 0,
  },
  working_days: 10,
  hours_per_day: 6,
};

const VELOCITY_DATA: ProjectVelocity = {
  sprints: [
    {
      id: 'sp-closed',
      name: 'Sprint zero',
      start_date: '2026-03-01',
      finish_date: '2026-03-14',
      committed_points: 20,
      completed_points: 18,
      committed_task_count: 8,
      completed_task_count: 7,
      exclude_from_velocity: false,
    },
  ],
  rolling_avg_points: 18,
  rolling_stdev_points: 2,
  forecast_range_low: 16,
  forecast_range_high: 20,
  rolling_avg_tasks: 7,
  rolling_stdev_tasks: 1,
  team_velocity_per_day: 1.8,
  excluded_count: 0,
};

/** A DRF 409 shaped like the sync-conflict body useUpdateTask already toasts. */
const SYNC_CONFLICT_ERROR = {
  isAxiosError: true,
  response: {
    status: 409,
    data: {
      code: 'sync_conflict',
      detail: 'Someone else changed this task.',
      conflict_fields: ['sprint'],
      server_value: {},
      client_value: {},
      server_version: 4,
    },
  },
};

describe('SprintsView — guards, gates, and overlay dismissal', () => {
  function setSprints(
    sprints: ApiSprint[],
    buckets: { closed?: ApiSprint[]; active?: ApiSprint | null; planned?: ApiSprint[] } = {},
    extras: { refetch?: () => void; error?: unknown } = {},
  ) {
    useSprintsMock.mockReturnValue({
      sprints,
      isLoading: false,
      error: extras.error ?? null,
      refetch: extras.refetch,
    });
    useSprintsByStateMock.mockReturnValue({
      closed: buckets.closed ?? [],
      active: buckets.active ?? null,
      planned: buckets.planned ?? [],
      isLoading: false,
      error: extras.error ?? null,
    });
  }

  beforeEach(() => {
    toastMocks.success.mockClear();
    toastMocks.error.mockClear();
    toastMocks.info.mockClear();
    window.sessionStorage.clear();
    projectIdMock.mockReturnValue('proj-1');
    useProjectMock.mockReturnValue({ data: DEFAULT_PROJECT, isLoading: false, error: null });
    canManageScopeMock.mockReturnValue(false);
    canEditGoalMock.mockReturnValue(false);
    currentRoleMock.mockReturnValue(ROLE_SCHEDULER);
    resourceIdMock.mockReturnValue(null);
    useMyActiveSprintsMock.mockReturnValue({ data: [], isLoading: false, error: null });
    useSprintBacklogMock.mockReset();
    useSprintBacklogMock.mockReturnValue({ data: undefined });
    useScheduleTasksMock.mockReturnValue({ tasks: undefined });
    useSprintCapacityMock.mockReset();
    useSprintCapacityMock.mockReturnValue({ data: undefined });
    useProjectVelocityMock.mockReturnValue({ data: undefined });
    useSprintOutcomeMock.mockReturnValue({ data: undefined });
    updateTaskMutate.mockReset();
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
  });

  // --- persisted filter, malformed payloads --------------------------------

  it('ignores a stored filter whose fields have the wrong types', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    window.sessionStorage.setItem(
      'trueppm.sprintFilter.sp-active',
      JSON.stringify({ assignee: 42, statuses: 'IN_PROGRESS' }),
    );
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(screen.getByRole('radio', { name: /^Anyone$/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Me$/i })).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: /In Progress/i, pressed: false }),
    ).toBeInTheDocument();
  });

  it('ignores a stored filter that is not valid JSON', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    window.sessionStorage.setItem('trueppm.sprintFilter.sp-active', '{not-json');
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(screen.getByRole('radio', { name: /^Anyone$/i })).toBeChecked();
    expect(
      screen.getByRole('button', { name: /In Progress/i, pressed: false }),
    ).toBeInTheDocument();
  });

  it('closes the filter popover from its own Apply control', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(screen.getByRole('dialog', { name: /Filter sprint backlog/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Close filter popover/i }));
    expect(
      screen.queryByRole('dialog', { name: /Filter sprint backlog/i }),
    ).not.toBeInTheDocument();
  });

  // --- the "c" quick-create shortcut guards --------------------------------

  it('ignores the "c" shortcut while the user is typing in a text field', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    canEditGoalMock.mockReturnValue(true);
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const goalField = screen.getByPlaceholderText(/What outcome does this sprint deliver\?/i);
    fireEvent.keyDown(goalField, { key: 'c' });
    expect(screen.queryByRole('dialog', { name: /Add task/i })).not.toBeInTheDocument();
  });

  it('ignores the "c" shortcut while a modal owns the surface', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Plan next sprint$/i }));
    expect(screen.getByRole('dialog', { name: /Plan next sprint/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'c' });
    expect(screen.queryByRole('dialog', { name: /Add task/i })).not.toBeInTheDocument();
  });

  it('ignores "c" when it carries a modifier (⌘/Ctrl/Alt belong to other bindings)', () => {
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    fireEvent.keyDown(document, { key: 'c', metaKey: true });
    fireEvent.keyDown(document, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'c', altKey: true });
    fireEvent.keyDown(document, { key: 'x' });
    expect(screen.queryByRole('dialog', { name: /Add task/i })).not.toBeInTheDocument();
  });

  it('closes the quick-create modal again from its own dismiss control', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    fireEvent.keyDown(document, { key: 'c' });
    expect(screen.getByRole('dialog', { name: /Add task/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Close add task/i }));
    expect(screen.queryByRole('dialog', { name: /Add task/i })).not.toBeInTheDocument();
  });

  // --- scope radiogroup: the rest of the roving-tabindex key map ------------

  it('scope radiogroup wraps on ArrowDown/ArrowUp/ArrowLeft and jumps on Home/End', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([ACTIVE], { active: ACTIVE });
    useMyActiveSprintsMock.mockReturnValue({
      data: [makeTeamEntry('p1', 'Alpha'), makeTeamEntry('p2', 'Beta')],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    const projectRadio = () => screen.getByRole('radio', { name: /This project/i });
    const teamsRadio = () => screen.getByRole('radio', { name: /My Teams \(2\)/i });
    projectRadio().focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(teamsRadio()).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{ArrowUp}');
    expect(projectRadio()).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{End}');
    expect(teamsRadio()).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{Home}');
    expect(projectRadio()).toHaveAttribute('aria-checked', 'true');

    // ArrowLeft from the first option wraps around to the last.
    await userEvent.keyboard('{ArrowLeft}');
    expect(teamsRadio()).toHaveAttribute('aria-checked', 'true');

    // An unmapped key must not move the selection.
    await userEvent.keyboard('x');
    expect(teamsRadio()).toHaveAttribute('aria-checked', 'true');
  });

  it('hides the scope switcher when the My-Teams read has not resolved', () => {
    setSprints([ACTIVE], { active: ACTIVE });
    useMyActiveSprintsMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(screen.queryByRole('radiogroup', { name: /Sprint scope/i })).not.toBeInTheDocument();
  });

  // --- missing project / role context --------------------------------------

  it('falls back to a generic breadcrumb while the project name is loading', () => {
    useProjectMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(screen.getByLabelText(/Breadcrumb/i)).toHaveTextContent(/^Project\s*\/\s*Sprints$/);
  });

  it('keeps the task drawer closed when there is no project in the route', () => {
    projectIdMock.mockReturnValue(undefined);
    useScheduleTasksMock.mockReturnValue({ tasks: [makeProjectTask()] });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/sprints?task=task-1'] });

    // The header still renders — the sprint data does not depend on the id.
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
    // …but every project-scoped overlay stays shut.
    expect(screen.queryByRole('dialog', { name: /Task detail/i })).not.toBeInTheDocument();
  });

  it('withholds lifecycle chrome while the role is still unknown', () => {
    currentRoleMock.mockReturnValue(null);
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(screen.queryByRole('button', { name: /Close active sprint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Plan next sprint/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  // --- error state retry ----------------------------------------------------

  it('refetches the sprint list from the inline error state', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const refetch = vi.fn();
    setSprints([], {}, { error: new Error('boom'), refetch });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('tolerates Retry when the query exposes no refetch', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([], {}, { error: new Error('boom') });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(screen.getByText(/Couldn't load sprints/i)).toBeInTheDocument();
  });

  // --- activation without warnings -----------------------------------------

  it('shows no capacity alert when activation returns no warnings', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const activateMutate = vi.fn((_id: string, opts: { onSuccess?: (data: unknown) => void }) =>
      opts.onSuccess?.({}),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: activateMutate },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    const readyPlanned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
    });
    setSprints([readyPlanned], { planned: [readyPlanned] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Activate/i }));
    expect(activateMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // --- scope review slide-over ---------------------------------------------

  it('opens and dismisses the pending-scope review slide-over', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    canManageScopeMock.mockReturnValue(true);
    useScheduleTasksMock.mockReturnValue({ tasks: [makeProjectTask()] });
    const pendingSprint = makeSprint({
      id: 'sp-active',
      state: 'ACTIVE',
      name: 'Pending scope',
      pending_count: 2,
    });
    setSprints([pendingSprint], { active: pendingSprint });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Review pending \(2\)/i }));
    expect(screen.getByRole('dialog', { name: /Review pending scope/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Close scope review/i }));
    expect(screen.queryByRole('dialog', { name: /Review pending scope/i })).not.toBeInTheDocument();
  });

  it('hides the Review pending button when the sprint reports no pending count', () => {
    canManageScopeMock.mockReturnValue(true);
    const noCount = makeSprint({
      id: 'sp-active',
      state: 'ACTIVE',
      name: 'No pending',
      pending_count: undefined,
    });
    setSprints([noCount], { active: noCount });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(screen.queryByRole('button', { name: /Review pending/i })).not.toBeInTheDocument();
  });

  // --- modal dismissal ------------------------------------------------------

  it('closes the Plan sprint modal from Cancel', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Plan next sprint$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /Plan next sprint/i })).not.toBeInTheDocument();
  });

  it('closes the Edit planned sprint modal from Cancel', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    setSprints([PLANNED_FAR], { planned: [PLANNED_FAR] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    expect(screen.getByRole('dialog', { name: /Edit planned sprint/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /Edit planned sprint/i })).not.toBeInTheDocument();
  });

  it('closes the close-sprint dialog from Cancel without firing the mutation', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn();
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /^Close/i })).not.toBeInTheDocument();
    expect(closeMutate).not.toHaveBeenCalled();
  });

  // --- close with a real carry-over destination ----------------------------

  it('carries incomplete work to the next planned sprint and names it in the toast', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn((_vars: unknown, opts: { onSuccess?: () => void }) =>
      opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([ACTIVE, PLANNED], { active: ACTIVE, planned: [PLANNED] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));

    // The dialog resolves "next planned" to the destination sprint id.
    expect(closeMutate).toHaveBeenCalledWith(
      { sprintId: 'sp-active', payload: { carry_over_to: 'sp-planned' } },
      expect.any(Object),
    );
    // Both rows are carry-eligible (IN_PROGRESS + BACKLOG) and the destination
    // sprint is named so the closer sees where the work went.
    expect(toastMocks.success).toHaveBeenCalledWith(
      'Telemetry & FAT prep closed — 3 tasks carried to Next up.',
    );
  });

  it('passes the pending-scope disposition through when the closer rejects them', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn((_vars: unknown, opts: { onSuccess?: () => void }) =>
      opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    const pendingActive = makeSprint({
      id: 'sp-active',
      state: 'ACTIVE',
      name: 'Telemetry & FAT prep',
      pending_count: 2,
    });
    setSprints([pendingActive], { active: pendingActive });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('radio', { name: /Reject them/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));

    expect(closeMutate).toHaveBeenCalledWith(
      {
        sprintId: 'sp-active',
        payload: { carry_over_to: 'backlog', pending_disposition: 'reject' },
      },
      expect.any(Object),
    );
  });

  it('skips the retro scroll when the closed sprint is not in the loaded list', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn((_vars: unknown, opts: { onSuccess?: () => void }) =>
      opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    // The active sprint is bucketed but absent from the flat list — the header
    // still numbers it, and selecting it resolves to no card body.
    setSprints([PLANNED], { active: ACTIVE, planned: [PLANNED] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(
      screen.getByRole('heading', { level: 1, name: /Sprint 1 — Telemetry & FAT prep/ }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /Run the Telemetry & FAT prep retro/i }),
    );
    // The banner clears even though there is no retro surface to scroll to.
    expect(
      screen.queryByRole('button', { name: /Run the Telemetry & FAT prep retro/i }),
    ).not.toBeInTheDocument();
  });

  // --- the task detail drawer round-trip -----------------------------------

  it('resolves the ?task= deep link against the project task list and closes again', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useScheduleTasksMock.mockReturnValue({
      tasks: [makeProjectTask(), makeProjectTask({ id: 'task-2', name: 'Second task' })],
    });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?task=task-1'],
    });

    expect(screen.getByRole('dialog', { name: /Task detail/i })).toHaveTextContent(
      'resolved:Wire the telemetry probe',
    );
    await userEvent.click(screen.getByRole('button', { name: /Close task drawer/i }));
    expect(screen.queryByRole('dialog', { name: /Task detail/i })).not.toBeInTheDocument();
  });

  it('leaves the drawer unresolved when the ?task= id is not in the project cache', () => {
    useScheduleTasksMock.mockReturnValue({ tasks: [makeProjectTask()] });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?task=not-cached'],
    });
    expect(screen.getByRole('dialog', { name: /Task detail/i })).toHaveTextContent(
      'resolved:unresolved',
    );
  });

  it('re-selects the kept task when a dirty drawer swap is canceled', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useScheduleTasksMock.mockReturnValue({
      tasks: [makeProjectTask(), makeProjectTask({ id: 'task-2', name: 'Second task' })],
    });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?task=task-1'],
    });

    await userEvent.click(screen.getByRole('button', { name: /Keep the current task/i }));
    expect(screen.getByRole('dialog', { name: /Task detail/i })).toHaveTextContent(
      'resolved:Second task',
    );
  });

  // --- active backlog writes ------------------------------------------------

  it('targets the active sprint from the backlog table Add task control', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /\+ Add task/i }));
    expect(screen.getByRole('dialog', { name: /Add task/i })).toHaveTextContent('target:sp-active');
  });

  it('opens the drawer from a backlog row', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    useScheduleTasksMock.mockReturnValue({ tasks: [makeProjectTask()] });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Open Wire the telemetry probe/i }));
    expect(screen.getByRole('dialog', { name: /Task detail/i })).toHaveTextContent(
      'resolved:Wire the telemetry probe',
    );
  });

  it('removes a task from the sprint and reports nothing extra on success', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    updateTaskMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Remove Second task from sprint/i }));
    expect(updateTaskMutate).toHaveBeenCalledWith(
      { id: 'task-2', projectId: 'proj-1', sprint: null },
      expect.any(Object),
    );
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('toasts a generic failure when remove-from-sprint fails for a non-conflict reason', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    updateTaskMutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error('500')));
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Remove Second task from sprint/i }));
    expect(toastMocks.error).toHaveBeenCalledWith(
      "Couldn't remove the task from the sprint — try again.",
    );
  });

  it('stays silent on a sync conflict so it never stacks with the conflict toast', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    updateTaskMutate.mockImplementation((_vars, opts) => opts?.onError?.(SYNC_CONFLICT_ERROR));
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Remove Second task from sprint/i }));
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('omits the backlog write controls for a viewer', () => {
    currentRoleMock.mockReturnValue(ROLE_VIEWER);
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-active' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(screen.queryByRole('button', { name: /\+ Add task/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove Second task from sprint/i }),
    ).not.toBeInTheDocument();
    // Read access is untouched — the rows are still listed.
    expect(screen.getByRole('button', { name: /Open Second task/i })).toBeInTheDocument();
  });

  // --- ACTIVE metrics row ---------------------------------------------------

  it('renders the live capacity and velocity panels instead of skeletons', () => {
    useSprintCapacityMock.mockImplementation((sprintId) => ({
      data: sprintId === 'sp-active' ? CAPACITY_DATA : undefined,
    }));
    useProjectVelocityMock.mockReturnValue({ data: VELOCITY_DATA });
    setSprints([ACTIVE], { active: ACTIVE });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(
      screen.queryByRole('status', { name: /Loading Capacity Preflight/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /Loading Velocity/i })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Capacity Preflight/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Velocity$/i })).toBeInTheDocument();
  });

  // --- PLANNED surface ------------------------------------------------------

  it('counts only assigned story points against the planned capacity ceiling', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const plannedWithCeiling = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      capacity_points: 20,
      start_date: '2026-04-15',
      finish_date: '2026-04-28',
    });
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-planned' ? BACKLOG_ROWS : undefined,
    }));
    useSprintCapacityMock.mockImplementation((sprintId) => ({
      data: sprintId === 'sp-planned' ? CAPACITY_DATA : undefined,
    }));
    useProjectVelocityMock.mockReturnValue({ data: VELOCITY_DATA });
    setSprints([plannedWithCeiling], { planned: [plannedWithCeiling] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    // Only the assigned 3-pointer counts; the unassigned 5-pointer is draft load
    // that nobody has picked up yet (#864, ADR-0094 §3).
    expect(screen.getByLabelText(/3 of 20 points planned/i)).toBeInTheDocument();
    // The planned surface offers the backlog story picker button (#2670) and a
    // collapsed velocity panel.
    expect(screen.getByRole('button', { name: 'Pull from backlog →' })).toBeInTheDocument();
    // The velocity disclosure renders its panel heading once expanded-in-DOM.
    expect(screen.getByRole('heading', { name: /^Velocity$/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /\+ Add task/i }));
    expect(screen.getByRole('dialog', { name: /Add task/i })).toHaveTextContent(
      'target:sp-planned',
    );
  });

  it('does not lend the head planned sprint’s candidates to a later planned sprint', () => {
    const head = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-15',
      finish_date: '2026-04-28',
    });
    const later = makeSprint({
      id: 'sp-planned-2',
      state: 'PLANNED',
      name: 'After that',
      start_date: '2026-04-29',
      finish_date: '2026-05-12',
    });
    const unestimated = [makeBacklogTask({ story_points: null })];
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-planned' ? unestimated : undefined,
    }));
    setSprints([head, later], { planned: [head, later] });

    const { unmount } = renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-planned'],
    });
    expect(screen.getByRole('heading', { name: /Estimation poker/i })).toBeInTheDocument();
    unmount();

    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-planned-2'],
    });
    expect(screen.queryByRole('heading', { name: /Estimation poker/i })).not.toBeInTheDocument();
  });

  // --- goal edit gate across states ----------------------------------------

  it('allows goal edit on the active sprint but freezes it once closed', () => {
    canEditGoalMock.mockReturnValue(true);
    setSprints([ACTIVE, CLOSED], { closed: [CLOSED], active: ACTIVE });

    const { unmount } = renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints'],
    });
    expect(screen.getByRole('button', { name: /^Edit$/i })).toBeInTheDocument();
    unmount();

    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-closed'],
    });
    expect(screen.queryByRole('button', { name: /^Edit$/i })).not.toBeInTheDocument();
  });

  it('gates the Sprint-0 velocity toggle and the reforecast card on role', () => {
    currentRoleMock.mockReturnValue(ROLE_ADMIN);
    useScheduleTasksMock.mockReturnValue({ tasks: [makeProjectTask()] });
    setSprints([ACTIVE, CLOSED], { closed: [CLOSED], active: ACTIVE });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-closed'],
    });
    // Admin is above both ROLE_SCHEDULER (toggle) and ROLE_ADMIN (reforecast).
    expect(screen.getByRole('status', { name: /Loading Sprint outcome/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('counts an assigned but unestimated row as zero points, not as missing', () => {
    const plannedWithCeiling = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      capacity_points: 20,
      start_date: '2026-04-15',
      finish_date: '2026-04-28',
    });
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-planned' ? BACKLOG_ROWS : undefined,
    }));
    useSprintCapacityMock.mockImplementation((sprintId) => ({
      data: sprintId === 'sp-planned' ? CAPACITY_DATA : undefined,
    }));
    setSprints([plannedWithCeiling], { planned: [plannedWithCeiling] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    // task-2 (3 pts, assigned) counts; task-3 is assigned with no estimate and
    // contributes 0 rather than breaking the sum.
    expect(screen.getByLabelText(/3 of 20 points planned/i)).toBeInTheDocument();
  });

  it('renders the planned surface read-only for a viewer', () => {
    currentRoleMock.mockReturnValue(ROLE_VIEWER);
    const planned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-15',
      finish_date: '2026-04-28',
    });
    useSprintBacklogMock.mockImplementation((_projectId, sprintId) => ({
      data: sprintId === 'sp-planned' ? BACKLOG_ROWS : undefined,
    }));
    setSprints([planned], { planned: [planned] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(screen.queryByRole('button', { name: /\+ Add task/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove Second task from sprint/i }),
    ).not.toBeInTheDocument();
    // The rows themselves are still readable.
    expect(screen.getByRole('button', { name: /Open Second task/i })).toBeInTheDocument();
  });

  it('renders the planning bridge with no project id in the route', () => {
    projectIdMock.mockReturnValue(undefined);
    const planned = makeSprint({
      id: 'sp-planned',
      state: 'PLANNED',
      name: 'Next up',
      start_date: '2026-04-15',
      finish_date: '2026-04-28',
    });
    setSprints([planned], { planned: [planned] });
    renderWithRouter(<SprintsView />, { initialEntries: ['/sprints'] });
    expect(screen.getByRole('heading', { name: /Planning bridge/i })).toBeInTheDocument();
  });

  it('keeps the closed-sprint panels read-only while the role is unknown', () => {
    currentRoleMock.mockReturnValue(null);
    setSprints([ACTIVE, CLOSED], { closed: [CLOSED], active: ACTIVE });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-closed'],
    });
    // Outcome is still loading, and no role-gated write chrome appears with it.
    expect(screen.getByRole('status', { name: /Loading Sprint outcome/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close active sprint/i })).not.toBeInTheDocument();
  });

  it('opens the scope review before the project task list has loaded', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    canManageScopeMock.mockReturnValue(true);
    // useScheduleTasks still pending → the panel receives an empty task list.
    const pendingSprint = makeSprint({
      id: 'sp-active',
      state: 'ACTIVE',
      name: 'Pending scope',
      pending_count: 1,
    });
    setSprints([pendingSprint], { active: pendingSprint });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Review pending \(1\)/i }));
    expect(screen.getByRole('dialog', { name: /Review pending scope/i })).toBeInTheDocument();
  });
});
