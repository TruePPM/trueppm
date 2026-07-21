import { useEffect } from 'react';
import { render, screen, cleanup, waitFor, act, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FIXTURE_TASKS, FIXTURE_LINKS } from '@/fixtures/tasks';
import type { Task, TaskLink } from '@/types';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_ADMIN } from '@/lib/roles';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useDragStore } from '@/stores/dragStore';

// ---------------------------------------------------------------------------
// matchMedia stub (jsdom lacks it). `mockMobile` flips the max-width branch that
// drives ScheduleView's `isMobile` (mobile MobileSchedule surface, #1671).
// ---------------------------------------------------------------------------
let mockMobile = false;
const makeMq = (query: string) => {
  const isMinWidth = /^\(min-width:/.test(query);
  // prefers-reduced-motion and max-width:767 both resolve via `mockMobile`
  // (max-width matches when mobile); min-width matches when NOT mobile.
  const matches = isMinWidth ? !mockMobile : mockMobile;
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
};
vi.stubGlobal('matchMedia', vi.fn().mockImplementation(makeMq));

// ---------------------------------------------------------------------------
// Mutable mock state — each test picks the tasks / role / surfaces it needs.
// ---------------------------------------------------------------------------
let mockTasks: Task[] | null = FIXTURE_TASKS;
let mockLinks: TaskLink[] = FIXTURE_LINKS;
let mockIsLoading = false;
let mockError: Error | null = null;
let mockRole: number | null = ROLE_MEMBER;
let mockSurfaces = { monte_carlo: true, baselines: true };
let mockBreakpoint: 'sm' | 'md' | 'lg' = 'lg';
let mockFeatureFlag = false;
let mockIsExporting = false;
let mockExportError: string | null = null;

const exportProjectMock = vi.fn();
const createTaskMutate = vi.fn(
  (vars: Record<string, unknown>, opts?: { onSuccess?: (created: { id: string }) => void }) => {
    opts?.onSuccess?.({ id: 'new-task-1', ...(vars as object) });
  },
);
const deleteTaskMutate = vi.fn();
const createBaselineMutate = vi.fn();
// Drag-to-link create (#1666). Capturable so create-link tests can assert the
// FS/0-lag payload and drive the onSuccess / onError branches.
const addDepMutate = vi.fn();

// Toast is fired by the create-link offline/cyclic branches and baseline
// capture — mock it so those code paths are observable without a ToastHost.
const toastInfo = vi.fn<(m: string) => void>();
const toastError = vi.fn<(m: string) => void>();
const toastSuccess = vi.fn<(m: string) => void>();
vi.mock('@/components/Toast', () => ({
  toast: {
    info: (m: string) => toastInfo(m),
    error: (m: string) => toastError(m),
    success: (m: string) => toastSuccess(m),
  },
}));

// Fake canvas engine handed to onEngineReady by the CanvasScheduleTimeline stub.
const fakeEngine = {
  on: vi.fn(() => vi.fn()),
  setHoverChain: vi.fn(),
  selectTask: vi.fn(),
  scrollToDate: vi.fn(),
  fitToProject: vi.fn(),
  updateTask: vi.fn(),
  scales: null,
  scrollLeft: 0,
};

// keyBindings captured from useScheduleKeyboard so tests can invoke the
// registered shortcut handlers directly (escape / mod+= / mod+m / mod+p …).
let capturedKeyBindings: Record<string, (e: KeyboardEvent) => void> = {};

// ---------------------------------------------------------------------------
// Data-hook mocks
// ---------------------------------------------------------------------------
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'project-1' }));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: mockTasks,
    links: mockLinks,
    isLoading: mockIsLoading,
    error: mockError,
  }),
}));
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [], isLoading: false }),
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: {
      id: 'project-1',
      name: 'Test Project',
      code: 'TP',
      program: null,
      start_date: '2026-10-01',
      start_floor: '2026-10-01',
      is_sample: false,
      recalculated_at: '2026-10-01T00:00:00Z',
    },
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { display_name: 'Test User' }, isLoading: false }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: mockRole, isLoading: false }),
}));
vi.mock('@/hooks/useSurfaceVisibility', () => ({
  useSurfaceVisibility: () => mockSurfaces,
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => mockBreakpoint,
}));
vi.mock('@/lib/featureFlags', () => ({
  useFeatureFlag: () => mockFeatureFlag,
}));
vi.mock('@/hooks/useBaselines', () => ({
  useCreateBaseline: () => ({ mutate: createBaselineMutate, isPending: false }),
  // ScheduleView reads the baseline list to pass activeBaselineName into the
  // capture confirm dialog (#2215). Default to no baselines.
  useBaselines: () => ({ data: [] }),
}));
vi.mock('@/hooks/useMsProjectImportExport', () => ({
  useExportMsProject: () => ({
    exportProject: exportProjectMock,
    isExporting: mockIsExporting,
    error: mockExportError,
  }),
}));
vi.mock('@/hooks/useGlobalShortcut', () => ({
  claimHelpShortcut: () => vi.fn(),
}));
vi.mock('@/hooks/useDragCpm', () => ({ useDragCpm: () => undefined }));
vi.mock('@/hooks/useKeyboardReschedule', () => ({ useKeyboardReschedule: () => undefined }));
vi.mock('@/hooks/useTaskMutations', () => ({
  useIndentTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useOutdentTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useDeleteTask: () => ({ mutate: deleteTaskMutate, isPending: false, variables: undefined }),
  useRestoreTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useCreateTask: () => ({ mutate: createTaskMutate, isPending: false, variables: undefined }),
  useAddDependency: () => ({ mutate: addDepMutate, isPending: false, variables: undefined }),
  parseCyclicDependencyError: (err: unknown) =>
    (err as { cyclic?: boolean } | null)?.cyclic ? { path: ['a', 'b'] } : null,
}));

// Schedule-local hooks
vi.mock('./useScheduleKeyboard', () => ({
  useScheduleKeyboard: (b: Record<string, (e: KeyboardEvent) => void>) => {
    capturedKeyBindings = b;
  },
}));
vi.mock('./useDependencyHover', () => ({
  useDependencyHover: () => ({
    hoveredId: null,
    chain: new Set<string>(),
    predecessors: new Set<string>(),
    successors: new Set<string>(),
  }),
}));
vi.mock('./useScheduleCommit', () => ({
  useScheduleCommit: () => ({
    state: null,
    beforeStartPrompt: null,
    isPending: false,
    beforeStartPending: false,
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
    handleDismissByOutsideClick: vi.fn(),
    handleSnapToProjectStart: vi.fn(),
    handleMoveProjectStart: vi.fn(),
    handleCancelBeforeStart: vi.fn(),
  }),
}));
vi.mock('./export/useScheduleExport', () => ({
  useScheduleExport: () => ({
    openDialog: vi.fn(),
    canExport: true,
    open: false,
    phase: 'idle',
    options: {
      paper: 'a4',
      includeArrows: true,
      includeOwnerColumn: true,
      includeCpSummary: true,
    },
    setOption: vi.fn(),
    filteredCount: 0,
    estimateMs: 0,
    progress: 0,
    result: null,
    error: null,
    visibleWindowAvailable: false,
    startExport: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    openInViewer: vi.fn(),
    closeDialog: vi.fn(),
    printSurfaceMounted: false,
    printRef: { current: null },
    printData: null,
    printDataDate: null,
  }),
}));

// ---------------------------------------------------------------------------
// Child-component stubs — the heavy canvas / drawer / modal children are
// covered by their own tests. Stubbing them keeps this suite focused on
// ScheduleView's own orchestration while still executing all of its JSX.
// ---------------------------------------------------------------------------
vi.mock('./CanvasScheduleTimeline', () => ({
  CanvasScheduleTimeline: ({
    tasks,
    links,
    onEngineReady,
  }: {
    tasks: Task[];
    links: TaskLink[];
    onEngineReady?: (e: unknown) => void;
  }) => {
    useEffect(() => {
      onEngineReady?.(fakeEngine);
    }, [onEngineReady]);
    return (
      <div data-testid="canvas-timeline">
        canvas:{tasks.length}:{links.length}
      </div>
    );
  },
}));
vi.mock('./TaskListPanel', () => ({
  TaskListPanel: ({ tasks }: { tasks: Task[] }) => (
    <div data-testid="task-list-panel">
      {tasks.map((t) => (
        <div key={t.id}>{t.name}</div>
      ))}
    </div>
  ),
}));
vi.mock('./mobile/MobileSchedule', () => ({
  MobileSchedule: ({ onAddTask }: { onAddTask: () => void }) => (
    <div data-testid="mobile-schedule">
      <button type="button" onClick={onAddTask}>
        mobile add task
      </button>
    </div>
  ),
}));
vi.mock('./TaskDetailDrawer', () => ({
  TaskDetailDrawer: ({
    task,
    onClose,
  }: {
    task: { id: string; name: string } | null;
    onClose: () => void;
  }) =>
    task ? (
      <div role="dialog" aria-label={`Task drawer ${task.name}`}>
        <button type="button" onClick={onClose}>
          Close drawer
        </button>
      </div>
    ) : null,
}));
vi.mock('@/features/board/TaskFormModal', () => ({
  TaskFormModal: ({
    isMilestone,
    onClose,
    onCreated,
  }: {
    isMilestone?: boolean;
    onClose: () => void;
    onCreated?: (id: string) => void;
  }) => (
    <div role="dialog" aria-label={isMilestone ? 'Milestone form' : 'Task form'}>
      <button type="button" onClick={onClose}>
        Close form
      </button>
      {onCreated && (
        <button type="button" onClick={() => onCreated('t6')}>
          simulate created
        </button>
      )}
    </div>
  ),
}));
vi.mock('@/components/toolbar/ToolbarOverflowMenu', () => ({
  ToolbarOverflowMenu: ({
    triggerAriaLabel,
    items,
  }: {
    triggerAriaLabel: string;
    items: { kind: string; id: string; label: string; disabled?: boolean; onSelect?: () => void }[];
  }) => (
    <div role="group" aria-label={triggerAriaLabel}>
      {items.map((it) =>
        it.kind === 'action' ? (
          <button key={it.id} type="button" disabled={it.disabled} onClick={it.onSelect}>
            {it.label}
          </button>
        ) : null,
      )}
    </div>
  ),
}));
vi.mock('./ScheduleDisplayMenu', () => ({
  ScheduleDisplayMenu: (p: {
    showCpOnly: boolean;
    setShowCpOnly: (v: boolean) => void;
    showCriticalOnly: boolean;
    setShowCriticalOnly: (v: boolean) => void;
    focusModeEnabled: boolean;
    setFocusModeEnabled: (v: boolean) => void;
    showMilestonesOnly: boolean;
    setShowMilestonesOnly: (v: boolean) => void;
  }) => (
    <div data-testid="display-menu">
      <button type="button" onClick={() => p.setShowCriticalOnly(!p.showCriticalOnly)}>
        toggle-crit
      </button>
      <button type="button" onClick={() => p.setShowMilestonesOnly(!p.showMilestonesOnly)}>
        toggle-ms
      </button>
    </div>
  ),
}));
vi.mock('./ScheduleAddMilestoneButton', () => ({
  ScheduleAddMilestoneButton: ({
    onAddMilestone,
    disabled,
  }: {
    onAddMilestone: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onAddMilestone} disabled={disabled}>
      + Milestone
    </button>
  ),
}));
vi.mock('./ScheduleAddPhaseButton', () => ({
  ScheduleAddPhaseButton: ({
    onAddPhase,
    disabled,
  }: {
    onAddPhase: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onAddPhase} disabled={disabled}>
      + Phase
    </button>
  ),
}));
vi.mock('./ScheduleForecastBar', () => ({
  ScheduleForecastBar: () => <div data-testid="forecast-bar" />,
}));
vi.mock('./MobileMonteCarloCard', () => ({
  MobileMonteCarloCard: () => <div data-testid="mobile-mc" />,
}));
vi.mock('./ScheduleSummaryChip', () => ({ ScheduleSummaryChip: () => null }));
vi.mock('./ScheduleViewModeToggle', () => ({ ScheduleViewModeToggle: () => null }));
vi.mock('./QuarterModeControl', () => ({ QuarterModeControl: () => null }));
vi.mock('./ZoomControl', () => ({ ZoomControl: () => null }));
vi.mock('./ScheduleLegend', () => ({ ScheduleLegend: () => null }));
vi.mock('./MonteCarloGanttMarkers', () => ({ MonteCarloGanttMarkers: () => null }));
vi.mock('./MilestonePulseOverlay', () => ({ MilestonePulseOverlay: () => null }));
vi.mock('./MilestoneDeltaTooltip', () => ({ MilestoneDeltaTooltip: () => null }));
vi.mock('./DateInputPopover', () => ({ DateInputPopover: () => null }));
vi.mock('./UnscheduledGutter', () => ({ UnscheduledGutter: () => null }));
vi.mock('./PendingCrossProjectReview', () => ({ PendingCrossProjectReview: () => null }));
vi.mock('@/features/project/RecalculatingBadge', () => ({ RecalculatingBadge: () => null }));
vi.mock('./ScheduleCommitPopover', () => ({ ScheduleCommitPopover: () => null }));
vi.mock('./BeforeProjectStartDialog', () => ({ BeforeProjectStartDialog: () => null }));
vi.mock('./ScheduleDependencyPicker', () => ({ ScheduleDependencyPicker: () => null }));
vi.mock('./export/ScheduleExportDialog', () => ({ ScheduleExportDialog: () => null }));
vi.mock('./export/SchedulePrintLayout', () => ({ SchedulePrintLayout: () => null }));
vi.mock('@/components/import/ImportModal', () => ({
  ImportModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Import modal">
      <button type="button" onClick={onClose}>
        Close import
      </button>
    </div>
  ),
}));
vi.mock('@/features/share/ShareViewDialog', () => ({ ShareViewDialog: () => null }));
vi.mock('./BaselineManagerModal', () => ({ BaselineManagerModal: () => null }));
vi.mock('./CaptureBaselineConfirmDialog', () => ({ CaptureBaselineConfirmDialog: () => null }));
vi.mock('./SubtreeDeleteConfirmDialog', () => ({ SubtreeDeleteConfirmDialog: () => null }));

// Import AFTER mocks so the mocked modules resolve.
import { ScheduleView } from './ScheduleView';

function renderSchedule(initialEntries: string[] = ['/']) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <ScheduleView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockTasks = FIXTURE_TASKS;
  mockLinks = FIXTURE_LINKS;
  mockIsLoading = false;
  mockError = null;
  mockRole = ROLE_MEMBER;
  mockSurfaces = { monte_carlo: true, baselines: true };
  mockBreakpoint = 'lg';
  mockFeatureFlag = false;
  mockMobile = false;
  mockIsExporting = false;
  mockExportError = null;
  capturedKeyBindings = {};
  exportProjectMock.mockReset();
  createTaskMutate.mockClear();
  deleteTaskMutate.mockReset();
  createBaselineMutate.mockReset();
  addDepMutate.mockReset();
  toastInfo.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  Object.values(fakeEngine).forEach((v) => {
    if (typeof v === 'function' && 'mockReset' in v) (v as ReturnType<typeof vi.fn>).mockReset();
  });
  fakeEngine.on.mockImplementation(() => vi.fn());
  // Reset shared zustand singletons so state doesn't leak across tests.
  useScheduleStore.setState({
    selectedTaskId: null,
    scheduleError: null,
    scheduleActionToast: null,
  });
  useWbsStore.setState({ expandedIds: new Set<string>() });
  useDragStore.setState({ phase: 'idle' });
  // jsdom canvas: make canvasIsSupported() report true by default.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ScheduleView — top-level states', () => {
  it('renders the query error state when task loading fails', () => {
    mockError = new Error('boom');
    renderSchedule();
    expect(screen.getByText(/couldn't load tasks/i)).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Schedule toolbar' })).toBeNull();
  });

  it('renders the loading skeleton while tasks load', () => {
    mockIsLoading = true;
    mockTasks = null;
    renderSchedule();
    expect(screen.getByLabelText('Loading Schedule')).toBeInTheDocument();
  });

  it('renders the canvas-unsupported fallback table', () => {
    (HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>).mockReturnValue(null);
    renderSchedule();
    // Fallback table headers + a task row rendered as plain text.
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Finish' })).toBeInTheDocument();
    // The fallback table itself carries the task row (as does the stubbed panel).
    const table = screen.getByRole('table');
    expect(within(table).getByText('Discovery & Design')).toBeInTheDocument();
    expect(within(table).getAllByText('10d').length).toBeGreaterThan(0);
    // The interactive canvas timeline never mounts in the fallback branch.
    expect(screen.queryByTestId('canvas-timeline')).toBeNull();
  });
});

describe('ScheduleView — empty state', () => {
  it('shows the create CTA for a member and opens the task form', async () => {
    const user = userEvent.setup();
    mockTasks = [];
    mockLinks = [];
    renderSchedule();
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: '+ Add task' });
    await user.click(cta);
    expect(screen.getByRole('dialog', { name: 'Task form' })).toBeInTheDocument();
  });

  it('omits the empty-state CTA for a read-only viewer', () => {
    mockTasks = [];
    mockLinks = [];
    mockRole = ROLE_VIEWER;
    renderSchedule();
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    // The toolbar "+ Task" button (aria-label "Add task") still exists; the
    // empty-state "+ Add task" action is omitted for the viewer.
    expect(screen.queryByRole('button', { name: '+ Add task' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeInTheDocument();
  });
});

describe('ScheduleView — populated desktop', () => {
  it('renders the toolbar and the canvas timeline with tasks + links', () => {
    renderSchedule();
    expect(screen.getByRole('toolbar', { name: 'Schedule toolbar' })).toBeInTheDocument();
    expect(screen.getByTestId('canvas-timeline')).toHaveTextContent('canvas:7:5');
    expect(screen.getByTestId('task-list-panel')).toBeInTheDocument();
  });

  it('toggles the create-task modal from the toolbar + button', async () => {
    const user = userEvent.setup();
    renderSchedule();
    const addBtn = screen.getByRole('button', { name: 'Add task' });
    expect(addBtn).toHaveAttribute('aria-expanded', 'false');
    await user.click(addBtn);
    expect(screen.getByRole('dialog', { name: 'Task form' })).toBeInTheDocument();
    expect(addBtn).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the milestone form from the "+ Milestone" button', async () => {
    const user = userEvent.setup();
    renderSchedule();
    await user.click(screen.getByRole('button', { name: '+ Milestone' }));
    expect(screen.getByRole('dialog', { name: 'Milestone form' })).toBeInTheDocument();
  });

  it('creates a phase (with a placeholder name) from the "+ Phase" button', async () => {
    const user = userEvent.setup();
    renderSchedule();
    await user.click(screen.getByRole('button', { name: '+ Phase' }));
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New phase' }),
      expect.anything(),
    );
  });

  it('scrolls the engine to today when the Today button is clicked', async () => {
    const user = userEvent.setup();
    renderSchedule();
    // Engine is wired via the CanvasScheduleTimeline stub's onEngineReady.
    await waitFor(() => expect(fakeEngine.on).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(fakeEngine.scrollToDate).toHaveBeenCalled();
  });
});

describe('ScheduleView — read-only vs authoring gates', () => {
  it('disables milestone + phase authoring for a viewer', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Phase' })).toBeDisabled();
  });

  it('enables milestone + phase authoring for a member', () => {
    mockRole = ROLE_MEMBER;
    renderSchedule();
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '+ Phase' })).toBeEnabled();
  });
});

describe('ScheduleView — project actions menu (role-gated)', () => {
  it('exposes Import / Share / Capture baseline for an admin', () => {
    mockRole = ROLE_ADMIN;
    renderSchedule();
    const menu = screen.getByRole('group', { name: 'Project actions' });
    expect(menu).toHaveTextContent('Import from MS Project…');
    expect(menu).toHaveTextContent('Share this schedule…');
    expect(menu).toHaveTextContent('Capture baseline');
  });

  it('hides admin-only actions for a member but keeps export + baselines', () => {
    mockRole = ROLE_MEMBER;
    renderSchedule();
    const menu = screen.getByRole('group', { name: 'Project actions' });
    expect(menu).not.toHaveTextContent('Import from MS Project…');
    expect(menu).not.toHaveTextContent('Share this schedule…');
    expect(menu).toHaveTextContent('Export to MS Project (.xml)');
    expect(menu).toHaveTextContent('Baselines…');
  });

  it('fires the MS Project export from the actions menu', async () => {
    const user = userEvent.setup();
    renderSchedule();
    await user.click(screen.getByRole('button', { name: 'Export to MS Project (.xml)' }));
    expect(exportProjectMock).toHaveBeenCalledTimes(1);
  });

  it('opens the import modal for an admin', async () => {
    const user = userEvent.setup();
    mockRole = ROLE_ADMIN;
    renderSchedule();
    await user.click(screen.getByRole('button', { name: 'Import from MS Project…' }));
    expect(screen.getByRole('dialog', { name: 'Import modal' })).toBeInTheDocument();
  });
});

describe('ScheduleView — Monte Carlo forecast surface gating', () => {
  it('renders the forecast bar when the surface is visible', () => {
    mockSurfaces = { monte_carlo: true, baselines: true };
    renderSchedule();
    expect(screen.getByTestId('forecast-bar')).toBeInTheDocument();
  });

  it('hides the forecast bar when the surface is turned off', () => {
    mockSurfaces = { monte_carlo: false, baselines: true };
    renderSchedule();
    expect(screen.queryByTestId('forecast-bar')).toBeNull();
    expect(screen.queryByTestId('mobile-mc')).toBeNull();
  });
});

describe('ScheduleView — mobile branch', () => {
  it('renders the dedicated mobile surface and no desktop toolbar', async () => {
    const user = userEvent.setup();
    mockMobile = true;
    renderSchedule();
    expect(screen.getByTestId('mobile-schedule')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Schedule toolbar' })).toBeNull();
    // Mobile "add task" opens the shared create form.
    await user.click(screen.getByRole('button', { name: 'mobile add task' }));
    expect(screen.getByRole('dialog', { name: 'Task form' })).toBeInTheDocument();
  });
});

describe('ScheduleView — display filters', () => {
  it('drops non-critical leaf rows when the critical-only filter is on', async () => {
    const user = userEvent.setup();
    renderSchedule();
    // All rows visible after the auto-expand effect runs.
    await screen.findByText('Frontend Build');
    await user.click(screen.getByRole('button', { name: 'toggle-crit' }));
    await waitFor(() => {
      expect(screen.queryByText('Frontend Build')).toBeNull(); // non-critical leaf t4
    });
    // Critical leaf + its summary parent remain.
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument(); // critical t2
    expect(screen.getByText('Alpha Platform Upgrade')).toBeInTheDocument(); // summary t1
  });

  it('seeds the milestones-only filter from the URL', async () => {
    renderSchedule(['/?ms=1']);
    await screen.findByText('Go-Live'); // milestone t6 survives
    expect(screen.queryByText('Discovery & Design')).toBeNull(); // non-milestone leaf dropped
  });
});

describe('ScheduleView — ?task deep-link', () => {
  it('opens the drawer for the linked task on arrival', async () => {
    renderSchedule(['/?task=t2']);
    await waitFor(() => {
      expect(useScheduleStore.getState().selectedTaskId).toBe('t2');
    });
    expect(
      screen.getByRole('dialog', { name: 'Task drawer Discovery & Design' }),
    ).toBeInTheDocument();
  });

  it('ignores a ?task id that does not exist', async () => {
    renderSchedule(['/?task=does-not-exist']);
    // Give the consume effect a chance to run against the loaded task tree.
    await screen.findByTestId('canvas-timeline');
    await waitFor(() => {
      expect(useScheduleStore.getState().selectedTaskId).toBeNull();
    });
  });
});

describe('ScheduleView — keyboard bindings', () => {
  it('escape clears hover, selection and the engine chain', () => {
    renderSchedule();
    act(() => {
      useScheduleStore.getState().setSelectedTaskId('t3');
    });
    act(() => {
      capturedKeyBindings['escape']?.(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
    expect(fakeEngine.setHoverChain).toHaveBeenCalledWith(null);
    expect(fakeEngine.selectTask).toHaveBeenCalledWith(null);
  });

  it('mod+= increases px-per-day (zoom in)', () => {
    renderSchedule();
    const before = useScheduleStore.getState().pxPerDay;
    const preventDefault = vi.fn();
    const e = { preventDefault } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+=']?.(e));
    expect(preventDefault).toHaveBeenCalled();
    expect(useScheduleStore.getState().pxPerDay).toBeGreaterThan(before);
  });

  it('mod+- decreases px-per-day (zoom out)', () => {
    renderSchedule();
    const before = useScheduleStore.getState().pxPerDay;
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+-']?.(e));
    expect(useScheduleStore.getState().pxPerDay).toBeLessThan(before);
  });

  it('mod+0 fits the project via the engine', () => {
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+0']?.(e));
    expect(fakeEngine.fitToProject).toHaveBeenCalled();
  });

  it('mod+m opens the milestone form for a member', () => {
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+m']?.(e));
    expect(screen.getByRole('dialog', { name: 'Milestone form' })).toBeInTheDocument();
  });

  it('mod+m is a no-op for a read-only viewer', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+m']?.(e));
    expect(screen.queryByRole('dialog', { name: 'Milestone form' })).toBeNull();
  });
});

describe('ScheduleView — action toast renderer', () => {
  it('renders a message + Undo action and fires + clears it on click', async () => {
    const user = userEvent.setup();
    renderSchedule();
    const onClick = vi.fn();
    act(() => {
      useScheduleStore.getState().setScheduleActionToast({
        message: 'Deleted “Alpha”',
        action: { label: 'Undo', onClick },
      });
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Deleted “Alpha”');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    // The handler didn't replace the toast, so the renderer clears it.
    expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
  });

  it('dismisses the action toast on Escape', async () => {
    renderSchedule();
    act(() => {
      useScheduleStore.getState().setScheduleActionToast({ message: 'Saved' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await waitFor(() => {
      expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
    });
  });
});

describe('ScheduleView — transient status surfaces', () => {
  it('shows the offline alert while a drag is in the error phase', () => {
    renderSchedule();
    act(() => {
      useDragStore.setState({ phase: 'error' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/offline — change not saved/i);
  });

  it('shows the schedule error toast from the store', () => {
    renderSchedule();
    act(() => {
      useScheduleStore.getState().setScheduleError('Progress must be anchored first.');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Progress must be anchored first.');
  });

  it('shows the export "preparing" status while exporting', () => {
    mockIsExporting = true;
    renderSchedule();
    expect(screen.getByRole('status')).toHaveTextContent(/preparing your export/i);
  });

  it('shows the export error alert when export fails', () => {
    mockExportError = 'Export failed.';
    renderSchedule();
    expect(screen.getByRole('alert')).toHaveTextContent('Export failed.');
  });
});

describe('ScheduleView — PanelSplitter (keyboard + pointer resize)', () => {
  it('nudges the task-list width right by 16px on ArrowRight', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize task list panel' });
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(before + 16);
  });

  it('nudges the task-list width left by 16px on ArrowLeft', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize task list panel' });
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(before - 16);
  });

  it('jumps to the min width on Home and the max width on End', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize task list panel' });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(600);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(120);
  });

  it('ignores non-resize keys (no width change)', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize task list panel' });
    const before = sep.getAttribute('aria-valuenow');
    fireEvent.keyDown(sep, { key: 'a' });
    expect(sep.getAttribute('aria-valuenow')).toBe(before);
  });

  it('resizes via a pointer drag (down → move updates aria-valuenow)', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize task list panel' });
    (sep).setPointerCapture = vi.fn();
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 140 });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(before + 40);
    fireEvent.pointerUp(sep);
    // After pointer-up the drag origin is cleared — a stray move does nothing.
    fireEvent.pointerMove(sep, { clientX: 300 });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(before + 40);
  });
});

describe('ScheduleView — ?cp filter drops non-critical dependency arrows', () => {
  it('passes only the critical links to the canvas when cp=1 is set', async () => {
    renderSchedule(['/?cp=1']);
    // FIXTURE_LINKS has 2 critical links (l1, l4); the other 3 are dropped.
    await waitFor(() => {
      expect(screen.getByTestId('canvas-timeline')).toHaveTextContent('canvas:7:2');
    });
  });
});

describe('ScheduleView — mod+p phase authoring binding', () => {
  it('creates a phase for a member', () => {
    renderSchedule();
    const preventDefault = vi.fn();
    const e = { preventDefault } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+p']?.(e));
    expect(preventDefault).toHaveBeenCalled();
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New phase' }),
      expect.anything(),
    );
  });

  it('is a no-op for a read-only viewer', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+p']?.(e));
    expect(createTaskMutate).not.toHaveBeenCalled();
  });
});

describe('ScheduleView — escape guard when a row menu is open', () => {
  it('does not clear the selection while a build-mode row menu is open', () => {
    renderSchedule();
    act(() => useScheduleStore.getState().setSelectedTaskId('t3'));
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Row actions');
    document.body.appendChild(menu);
    act(() => {
      capturedKeyBindings['escape']?.(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    // The menu owns Escape first — selection must survive.
    expect(useScheduleStore.getState().selectedTaskId).toBe('t3');
    expect(fakeEngine.selectTask).not.toHaveBeenCalled();
    menu.remove();
  });
});

describe('ScheduleView — canvas engine events', () => {
  function captureEngineHandlers() {
    const handlers: Record<string, (arg: unknown) => void> = {};
    (fakeEngine.on as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      (evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
        return vi.fn();
      },
    );
    return handlers;
  }

  it('opens the drawer and selects the bar on a canvas task-open (double-click)', async () => {
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['task-open']).toBeDefined());
    act(() => handlers['task-open']({ id: 't2' }));
    expect(useScheduleStore.getState().selectedTaskId).toBe('t2');
    expect(fakeEngine.selectTask).toHaveBeenCalledWith('t2');
    expect(
      screen.getByRole('dialog', { name: 'Task drawer Discovery & Design' }),
    ).toBeInTheDocument();
  });

  it('commits a drag-to-link gesture as an FS/0-lag dependency for a member', async () => {
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    expect(addDepMutate).toHaveBeenCalledWith(
      { predecessor: 't2', successor: 't3', dep_type: 'FS', lag: 0 },
      expect.anything(),
    );
  });

  it('ignores a drag-to-link gesture for a read-only viewer', async () => {
    mockRole = ROLE_VIEWER;
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    expect(addDepMutate).not.toHaveBeenCalled();
  });

  it('skips the link mutation and warns when offline', async () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    expect(addDepMutate).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/offline/i));
    onLineSpy.mockRestore();
  });

  it('announces the link on success via the polite aria-live region', async () => {
    addDepMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    const handlers = captureEngineHandlers();
    const { container } = renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite?.textContent).toBe('Linked Discovery & Design → Backend Implementation.');
  });

  it('surfaces a circular-dependency error toast when the link would cycle', async () => {
    addDepMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
        opts.onError?.({ cyclic: true }),
    );
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/circular dependency/i));
  });

  it('shows a generic error toast for a non-cyclic link failure', async () => {
    addDepMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void }) => opts.onError?.({}),
    );
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not create the link/i));
  });
});

describe('ScheduleView — drawer close reverts canvas highlights', () => {
  it('clears selection, hover chain and engine ring when the drawer closes', async () => {
    const user = userEvent.setup();
    renderSchedule(['/?task=t2']);
    await waitFor(() =>
      expect(useScheduleStore.getState().selectedTaskId).toBe('t2'),
    );
    await user.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
    expect(fakeEngine.setHoverChain).toHaveBeenCalledWith(null);
    expect(fakeEngine.selectTask).toHaveBeenCalledWith(null);
  });
});

describe('ScheduleView — milestone created side effect', () => {
  it('announces the inserted milestone to the polite aria-live region', async () => {
    const user = userEvent.setup();
    const { container } = renderSchedule();
    await user.click(screen.getByRole('button', { name: '+ Milestone' }));
    await user.click(screen.getByRole('button', { name: 'simulate created' }));
    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite?.textContent).toBe('Milestone Go-Live inserted at 2026-11-14');
  });
});

describe('ScheduleView — build mode (schedule_build_mode_v1 flag on)', () => {
  it('shows the build-mode pill and opens the cheatsheet on click', async () => {
    const user = userEvent.setup();
    mockFeatureFlag = true;
    renderSchedule();
    const pill = screen.getByTestId('build-mode-pill');
    expect(pill).toBeInTheDocument();
    await user.click(pill);
    expect(screen.getByRole('dialog', { name: /schedule shortcuts/i })).toBeInTheDocument();
  });

  it('toggles the cheatsheet with the ? key binding', () => {
    mockFeatureFlag = true;
    renderSchedule();
    expect(screen.queryByRole('dialog', { name: /schedule shortcuts/i })).toBeNull();
    const preventDefault = vi.fn();
    const e = { preventDefault } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['?']?.(e));
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /schedule shortcuts/i })).toBeInTheDocument();
    act(() => capturedKeyBindings['?']?.(e));
    expect(screen.queryByRole('dialog', { name: /schedule shortcuts/i })).toBeNull();
  });

  it('renders the build-mode empty state and creates the first task', async () => {
    const user = userEvent.setup();
    mockFeatureFlag = true;
    mockTasks = [];
    mockLinks = [];
    renderSchedule();
    // Build-mode empty state (region) — distinct from the read-only ScheduleEmptyState.
    expect(screen.getByRole('region', { name: 'No tasks yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add task' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /add first task/i }));
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New task', duration: 1 }),
      expect.anything(),
    );
  });
});

describe('ScheduleView — role still loading (pessimistic gating)', () => {
  it('hides admin-only Import but keeps the forecast surface while role is null', () => {
    mockRole = null;
    renderSchedule();
    const menu = screen.getByRole('group', { name: 'Project actions' });
    expect(menu).not.toHaveTextContent('Import from MS Project…');
    expect(menu).not.toHaveTextContent('Share this schedule…');
    // Monte Carlo is visible to a not-yet-resolved role (null || >= member).
    expect(screen.getByTestId('forecast-bar')).toBeInTheDocument();
  });
});
