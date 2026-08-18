import { useEffect, type ReactNode } from 'react';
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
let mockIsExporting = false;
let mockExportError: string | null = null;
// Server-resolved methodology (#2619) — drives the explanatory empty state.
// `undefined` lets ScheduleView's own `?? 'HYBRID'` fallback apply, matching
// every pre-#2619 test's implicit expectation.
let mockEffectiveMethodology: string | undefined;

const exportProjectMock = vi.fn();
let createTaskCounter = 0;
const createTaskMutate = vi.fn(
  (vars: Record<string, unknown>, opts?: { onSuccess?: (created: { id: string }) => void }) => {
    opts?.onSuccess?.({ id: 'new-task-1', ...(vars as object) });
  },
);
// duplicateSubtree (#2727, ADR-0776 §2) awaits mutateAsync sequentially to
// remap each clone's parent_id — the sync-only `mutate` mock above can't
// drive that. Each call gets a distinct id so a subtree walk's `idMap`
// resolves correctly.
const createTaskMutateAsync = vi.fn((vars: Record<string, unknown>) => {
  createTaskCounter += 1;
  return Promise.resolve({ id: `dup-task-${createTaskCounter}`, ...(vars as object) });
});
const deleteTaskMutate = vi.fn();
const reorderTaskMutate = vi.fn();
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
  setFilterHighlight: vi.fn(),
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
      effective_methodology: mockEffectiveMethodology,
    },
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { id: 'test-user-1', display_name: 'Test User' },
    isLoading: false,
  }),
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
vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useIndentTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
    useOutdentTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
    useUpdateTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
    useDeleteTask: () => ({ mutate: deleteTaskMutate, isPending: false, variables: undefined }),
    useRestoreTask: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
    useCreateTask: () => ({
      mutate: createTaskMutate,
      mutateAsync: createTaskMutateAsync,
      isPending: false,
      variables: undefined,
    }),
    useReorderTasks: () => ({ mutate: reorderTaskMutate, isPending: false, variables: undefined }),
    useAddDependency: () => ({ mutate: addDepMutate, isPending: false, variables: undefined }),
    parseCyclicDependencyError: (err: unknown) =>
      (err as { cyclic?: boolean } | null)?.cyclic ? { path: ['a', 'b'] } : null,
  };
});

// Captures the real, fully-wired BuildModeApi that ScheduleView hands to
// <BuildModeProvider> — same capture-into-module-var pattern as
// capturedKeyBindings below. TaskListPanel is stubbed out (it has its own
// tests), so this is the only way to exercise duplicateSubtree's actual
// orchestration (#2727, ADR-0776 §2: subtree walk, id remapping, top-level-
// selected-node filtering) rather than just asserting a row delegates to it.
let capturedBuildMode: import('./buildMode').BuildModeApi | null = null;
vi.mock('./buildMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./buildMode')>();
  return {
    ...actual,
    BuildModeProvider: ({
      api,
      children,
    }: {
      api: import('./buildMode').BuildModeApi;
      children: ReactNode;
    }) => {
      capturedBuildMode = api;
      return <actual.BuildModeProvider api={api}>{children}</actual.BuildModeProvider>;
    },
  };
});

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
  // The real draft row lives in TaskListPanel (and has its own spec); this stub
  // surfaces `onCommitDraftRow` so ScheduleView's half of the wiring — that the
  // callback reaches the outline and creates the typed task — is still covered
  // here (#2733).
  TaskListPanel: ({
    tasks,
    onCommitDraftRow,
  }: {
    tasks: Task[];
    onCommitDraftRow?: (name: string) => void;
  }) => (
    <div data-testid="task-list-panel">
      {tasks.map((t) => (
        <div key={t.id}>{t.name}</div>
      ))}
      {onCommitDraftRow && (
        <button type="button" onClick={() => onCommitDraftRow('Pour foundations')}>
          commit-draft
        </button>
      )}
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

/**
 * The Schedule's transient status surface (toast / export progress).
 *
 * ScheduleView legitimately holds more than one `role="status"` node since
 * ADR-0784 added the always-mounted reconciliation live region, so a bare
 * `getByRole('status')` is ambiguous. Exclude the reconciliation region rather
 * than loosening the assertion.
 */
function getScheduleStatus(): HTMLElement {
  const regions = screen
    .getAllByRole('status')
    .filter((n) => n.getAttribute('data-testid') !== 'reconcile-live');
  expect(regions).toHaveLength(1);
  return regions[0];
}

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
  mockMobile = false;
  mockIsExporting = false;
  mockExportError = null;
  mockEffectiveMethodology = undefined;
  capturedKeyBindings = {};
  capturedBuildMode = null;
  exportProjectMock.mockReset();
  createTaskMutate.mockClear();
  createTaskMutateAsync.mockClear();
  createTaskCounter = 0;
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
  it('opens with a live draft row and creates the typed task (#2733)', async () => {
    // #2733 deleted the "No tasks yet / Add first task" card. A card is a thing
    // you must dismiss before you can work; the outline now opens with the caret
    // already in row 1, so the first keystroke is the first task.
    const user = userEvent.setup();
    mockTasks = [];
    mockLinks = [];
    renderSchedule();

    await user.click(screen.getByRole('button', { name: 'commit-draft' }));

    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pour foundations', duration: 1 }),
    );
  });

  // #2682/#2733: the blank canvas is reachable by every desktop role, so a Viewer
  // must not get a caret in a field that cannot save, nor fill options that all
  // write. They get a static line and the read-only facts instead.
  it('gives a read-only viewer no draft input and no fill options', () => {
    mockTasks = [];
    mockLinks = [];
    mockRole = ROLE_VIEWER;
    renderSchedule();
    expect(screen.queryByRole('button', { name: 'commit-draft' })).toBeNull();
    expect(screen.queryByText(/other ways to fill it/i)).not.toBeInTheDocument();
    // ...but the facts still render — a Viewer should still see what this project is.
    expect(screen.getByText(/this project/i)).toBeInTheDocument();
  });

  // #2619: AGILE hides this route's nav entry, but it stays reachable by direct
  // URL — the bug was the cold-start CTA never saying so.
  it('shows the methodology-mismatch empty state on an AGILE project', () => {
    mockTasks = [];
    mockLinks = [];
    mockEffectiveMethodology = 'AGILE';
    renderSchedule();
    expect(screen.getByText("Schedule isn't part of this project's workflow")).toBeInTheDocument();
    expect(screen.queryByText(/no tasks yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Sprints' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
  });

  it('draws the blank canvas on a non-AGILE project (#2733)', () => {
    mockTasks = [];
    mockLinks = [];
    mockEffectiveMethodology = 'HYBRID';
    renderSchedule();
    // The horizon and the project's own facts, not a card.
    expect(screen.getByRole('button', { name: 'commit-draft' })).toBeInTheDocument();
    expect(screen.getByText(/this project/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Schedule isn't part of this project's workflow"),
    ).not.toBeInTheDocument();
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
  // The Author/Read preference persists per-user per-project, so a test that
  // toggles it leaks into every later test in the file unless it is cleared
  // here (the Author/Read describe below clears the same key for the same
  // reason).
  beforeEach(() => {
    window.localStorage.removeItem('trueppm.schedule.authorMode.test-user-1.project-1');
  });

  it('gives a viewer no authoring apparatus at all — absent, not disabled (#2949)', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    // A viewer is not "in Read mode": there is no mode, because nothing is on
    // offer. Offering a control and then refusing it teaches them the product
    // is broken, so the create controls and the mode toggle are gone entirely.
    expect(screen.queryByRole('button', { name: '+ Milestone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Phase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('author-mode-pill')).not.toBeInTheDocument();
  });

  it('tells a viewer what to do instead, once', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    const badge = screen.getByTestId('schedule-view-only');
    expect(badge).toHaveTextContent('View only');
    expect(badge).toHaveTextContent('Ask the project owner for edit rights');
  });

  it('keeps the apparatus present and inert for an EDITOR who chose Read', async () => {
    // The state that must not collapse into the one above: an editor can get
    // back with one key, so the controls stay where they were.
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Read');
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeDisabled();
    expect(screen.queryByTestId('schedule-view-only')).not.toBeInTheDocument();
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
    const status = getScheduleStatus();
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
    expect(getScheduleStatus()).toHaveTextContent('Saved');
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
    expect(getScheduleStatus()).toHaveTextContent(/preparing your export/i);
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
    sep.setPointerCapture = vi.fn();
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
    addDepMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) =>
      opts.onSuccess?.(),
    );
    const handlers = captureEngineHandlers();
    const { container } = renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    const polite = container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(polite?.textContent).toBe('Linked Discovery & Design → Backend Implementation.');
  });

  it('surfaces a circular-dependency error toast when the link would cycle', async () => {
    addDepMutate.mockImplementation((_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.({ cyclic: true }),
    );
    const handlers = captureEngineHandlers();
    renderSchedule();
    await waitFor(() => expect(handlers['create-link']).toBeDefined());
    act(() => handlers['create-link']({ sourceId: 't2', targetId: 't3' }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/circular dependency/i));
  });

  it('shows a generic error toast for a non-cyclic link failure', async () => {
    addDepMutate.mockImplementation((_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.({}),
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
    await waitFor(() => expect(useScheduleStore.getState().selectedTaskId).toBe('t2'));
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
    const polite = container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(polite?.textContent).toBe('Milestone Go-Live inserted at 2026-11-14');
  });
});

describe('ScheduleView — build mode (default on desktop, #2682)', () => {
  it('shows the build-mode pill and opens the cheatsheet on click', async () => {
    const user = userEvent.setup();
    renderSchedule();
    const pill = screen.getByTestId('build-mode-pill');
    expect(pill).toBeInTheDocument();
    await user.click(pill);
    expect(screen.getByRole('dialog', { name: /schedule shortcuts/i })).toBeInTheDocument();
  });

  it('toggles the cheatsheet with the ? key binding', () => {
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

  it('renders the blank canvas and creates the first task from the draft row', async () => {
    const user = userEvent.setup();
    mockTasks = [];
    mockLinks = [];
    renderSchedule();
    // The blank canvas: a live outline row plus the quiet fill panel (#2733).
    expect(screen.getByRole('complementary', { name: /ways to fill this project/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add task' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'commit-draft' }));
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pour foundations', duration: 1 }),
    );
  });
});

describe('ScheduleView — Alt+A Author/Read toggle (#2727, ADR-0776 §5)', () => {
  // The hook persists to localStorage keyed by user+project — clear it so
  // one test's toggle doesn't leak into the next test's "fresh mount" default.
  beforeEach(() => {
    window.localStorage.removeItem('trueppm.schedule.authorMode.test-user-1.project-1');
  });

  it('defaults to Author mode: pill reads "Author" and create controls stay enabled', () => {
    renderSchedule();
    const pill = screen.getByTestId('author-mode-pill');
    expect(pill).toHaveTextContent('Author');
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeEnabled();
  });

  it('clicking the pill switches to Read mode and disables create controls', async () => {
    const user = userEvent.setup();
    renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Read');
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Phase' })).toBeDisabled();
  });

  it('Alt+A toggles the same as clicking the pill', () => {
    renderSchedule();
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Author');
    const preventDefault = vi.fn();
    const e = { preventDefault } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['alt+a']?.(e));
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Read');
    act(() => capturedKeyBindings['alt+a']?.(e));
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Author');
  });

  it('is not a permission change — the server role gate still applies independently', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    // A Viewer is already readOnly via the role gate, before Read mode is ever
    // touched — Author/Read layers on top, it doesn't replace this. Since
    // #2949 that shows up as the apparatus being absent rather than disabled,
    // and the toggle itself is gone: there is no mode for a viewer to be in.
    expect(screen.queryByRole('button', { name: '+ Milestone' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('author-mode-pill')).not.toBeInTheDocument();
    expect(screen.getByTestId('schedule-view-only')).toBeInTheDocument();
  });

  it('persists the preference per-user per-project across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Read');
    unmount();
    renderSchedule();
    await waitFor(() =>
      expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Read'),
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
    // Monte Carlo carries no role gate at all (#2492) — see the dedicated
    // describe below for the full role matrix.
    expect(screen.getByTestId('forecast-bar')).toBeInTheDocument();
  });
});

describe('ScheduleView — forecast surface is not role-gated (#2492)', () => {
  // The forecast is a read: the server grants it to any project member
  // (IsProjectMember on run_monte_carlo / MonteCarloHistoryView) and the mobile
  // card is ungated. The desktop bar previously gated at Member+, so a Viewer
  // saw P50/P80/P95 on a phone and not on a laptop. Asserting every role here
  // is what stops the gate being reintroduced.
  it.each([
    ['viewer', ROLE_VIEWER],
    ['member', ROLE_MEMBER],
    ['admin', ROLE_ADMIN],
    ['unresolved (null)', null],
  ])('desktop and mobile forecast surfaces agree for a %s', (_label, role) => {
    mockRole = role;
    renderSchedule();
    expect(screen.getByTestId('forecast-bar')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-mc')).toBeInTheDocument();
  });
});

describe('ScheduleView — buildModeApi.duplicateSubtree (#2727, ADR-0776 §2)', () => {
  // FIXTURE_TASKS: t1 "Alpha Platform Upgrade" (root, wbs 1) has children
  // t2 "Discovery & Design" (leaf), t3, t4, t5, t6 (all wbs 1.x); t7
  // "Documentation" (root, wbs 2) is a separate, unrelated leaf.

  it('duplicates a leaf as a single row with the "(copy)" suffix', async () => {
    renderSchedule();
    act(() => {
      capturedBuildMode!.duplicateSubtree('t2');
    });
    await waitFor(() => expect(createTaskMutateAsync).toHaveBeenCalledTimes(1));
    expect(createTaskMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Discovery & Design (copy)',
        parent_id: 't1',
        duration: 10,
      }),
    );
  });

  it('duplicates a summary and its full subtree, remapping parent_id top-down', async () => {
    renderSchedule();
    act(() => {
      capturedBuildMode!.duplicateSubtree('t1');
    });
    // t1 + its 5 children (t2..t6) = 6 sequential creates.
    await waitFor(() => expect(createTaskMutateAsync).toHaveBeenCalledTimes(6));
    const [rootPayload] = createTaskMutateAsync.mock.calls[0];
    expect(rootPayload).toMatchObject({ name: 'Alpha Platform Upgrade (copy)', parent_id: null });
    // The mock hands out ids "dup-task-N" in call order — the root's clone is dup-task-1.
    const childPayloads = createTaskMutateAsync.mock.calls.slice(1).map(([p]) => p);
    for (const payload of childPayloads) {
      expect(payload.parent_id).toBe('dup-task-1');
      expect(payload.name).not.toMatch(/\(copy\)/); // descendants keep their source name
    }
  });

  it('is a no-op when the task is not found in the tree', () => {
    renderSchedule();
    act(() => {
      capturedBuildMode!.duplicateSubtree('does-not-exist');
    });
    expect(createTaskMutateAsync).not.toHaveBeenCalled();
  });

  it('multi-select: duplicates only top-level selected nodes as subtree roots', async () => {
    renderSchedule();
    // t2 is a child of t1; selecting both means t2 is already covered by
    // t1's own subtree walk and must not be duplicated a second time. t7 is
    // an unrelated root and gets its own subtree walk. Each dispatch runs in
    // its own act() so `capturedBuildMode` (re-captured on every render) sees
    // the updated focus.state before the next call reads it — combining them
    // in one act() would still read the pre-select state, since dispatch
    // batching doesn't flush mid-callback.
    act(() => {
      capturedBuildMode!.focus.focusRow('t1');
    });
    act(() => {
      capturedBuildMode!.focus.selectIds(['t1', 't2', 't7']);
    });
    act(() => {
      capturedBuildMode!.duplicateSubtree('t1');
    });
    // t1's subtree (t1..t6 = 6) + t7's subtree (t7 = 1) = 7. If t2 were
    // wrongly duplicated a second time as its own root, this would be 8.
    await waitFor(() => expect(createTaskMutateAsync).toHaveBeenCalledTimes(7));
    const names = createTaskMutateAsync.mock.calls.map(([p]) => p.name as string);
    expect(names.filter((n) => n.includes('Discovery & Design'))).toHaveLength(1);
  });
});

describe('ScheduleView — F8/Shift+F8 unresolved-owner-token navigation (#2727, ADR-0776 §3)', () => {
  // useProjectResourcePool is not mocked in this file — the real hook runs
  // against no network client in jsdom and `.data` stays undefined, which
  // the F8 binding treats as an empty roster. An empty roster can never
  // resolve an @token, so every @mention below reads as "unresolved" —
  // exactly the fixture this predicate needs, with no extra mocking.
  const UNRESOLVED_TASKS: Task[] = [
    { ...FIXTURE_TASKS[0], id: 'u1', wbs: '1', name: 'Plan', parentId: null },
    { ...FIXTURE_TASKS[0], id: 'u2', wbs: '2', name: 'Build @nobody', parentId: null },
    { ...FIXTURE_TASKS[0], id: 'u3', wbs: '3', name: 'Ship it', parentId: null },
    { ...FIXTURE_TASKS[0], id: 'u4', wbs: '4', name: 'Review @ghost', parentId: null },
    { ...FIXTURE_TASKS[0], id: 'u5', wbs: '5', name: 'Done', parentId: null },
  ];

  beforeEach(() => {
    mockTasks = UNRESOLVED_TASKS;
    mockLinks = [];
  });

  it('F8 with nothing focused jumps to the first unresolved row', () => {
    renderSchedule();
    const preventDefault = vi.fn();
    act(() => capturedKeyBindings['f8']?.({ preventDefault } as unknown as KeyboardEvent));
    expect(preventDefault).toHaveBeenCalled();
    expect(capturedBuildMode!.focus.state.rowId).toBe('u2');
  });

  it('a second F8 advances to the next unresolved row', () => {
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['f8']?.(e));
    act(() => capturedKeyBindings['f8']?.(e));
    expect(capturedBuildMode!.focus.state.rowId).toBe('u4');
  });

  it('F8 wraps around past the last unresolved row', () => {
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['f8']?.(e)); // -> u2
    act(() => capturedKeyBindings['f8']?.(e)); // -> u4
    act(() => capturedKeyBindings['f8']?.(e)); // wraps -> u2
    expect(capturedBuildMode!.focus.state.rowId).toBe('u2');
  });

  it('Shift+F8 with nothing focused jumps to the last unresolved row', () => {
    renderSchedule();
    const preventDefault = vi.fn();
    act(() =>
      capturedKeyBindings['shift+f8']?.({ preventDefault } as unknown as KeyboardEvent),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(capturedBuildMode!.focus.state.rowId).toBe('u4');
  });

  it('Shift+F8 after F8 moves back to the previous unresolved row', () => {
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['f8']?.(e)); // -> u2
    act(() => capturedKeyBindings['f8']?.(e)); // -> u4
    act(() => capturedKeyBindings['shift+f8']?.(e)); // back -> u2
    expect(capturedBuildMode!.focus.state.rowId).toBe('u2');
  });

  it('is a no-op when no row has an unresolved owner token', () => {
    mockTasks = [{ ...FIXTURE_TASKS[0], id: 'r1', wbs: '1', name: 'Plan', parentId: null }];
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['f8']?.(e));
    expect(capturedBuildMode!.focus.state.rowId).toBeNull();
  });
});
