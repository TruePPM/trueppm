import { useEffect, type ReactNode } from 'react';
import { formatChord } from '@/lib/platform';
import { render, screen, cleanup, waitFor, act, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FIXTURE_TASKS, FIXTURE_LINKS } from '@/fixtures/tasks';
import type { Task, TaskLink } from '@/types';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN } from '@/lib/roles';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useTrailStore, newestUndoableEntry } from './trail/trailStore';
import { AUTHOR_PARENT_PARAM } from './authorParam';
import { TaskGroupingRefused } from '@/hooks/useTaskGrouping';
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
let mockRoleError = false;
/**
 * `can_author` as the SERVER would compute it (#3034, ADR-0773 §2).
 *
 * `ScheduleView`'s authoring gate reads `Project.can_author`, not the role
 * ordinal, so this mock stands in for `role_can_author_plan` rather than for a
 * second client-side rule — which is why it reproduces the band exclusion
 * (`>= MEMBER` *minus* the 200–299 resource-management band) instead of a plain
 * threshold. Deriving it from `mockRole` keeps every existing role-driven test
 * in this file honest; the Scheduler cases below are the ones that would pass
 * under a plain `>=` and must not.
 *
 * Set `mockCanAuthorOverride` to model a state the role cannot express:
 * `'unresolved'` is the project detail not having landed yet, which is a
 * different thing from the server answering "no".
 */
let mockCanAuthorOverride: boolean | 'unresolved' | undefined;
function serverCanAuthor(): boolean | undefined {
  if (mockCanAuthorOverride === 'unresolved') return undefined;
  if (mockCanAuthorOverride !== undefined) return mockCanAuthorOverride;
  if (mockRole == null) return false;
  if (mockRole >= ROLE_SCHEDULER && mockRole < ROLE_ADMIN) return false;
  return mockRole >= ROLE_MEMBER;
}
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
// Set to make the next create REFUSE instead of succeeding. Without it the
// `onError` arm is unreachable and, worse, the property #3018 turns on —
// announce and record on SUCCESS, never on the keystroke — is untestable: a mock
// that only ever succeeds cannot tell a create-time recordAct from a
// success-time one.
let nextCreateTaskFails = false;
const createTaskMutate = vi.fn(
  (
    vars: Record<string, unknown>,
    opts?: { onSuccess?: (created: { id: string }) => void; onError?: (e: unknown) => void },
  ) => {
    if (nextCreateTaskFails) {
      opts?.onError?.(new Error('create refused'));
      return;
    }
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
// Group / Ungroup (#2955). Each drives its `onSuccess` synchronously with a fixture
// response so the outcome copy, the trail entry and the ledger binding are all
// observable without a server.
// Set to make the next group/ungroup REFUSE instead of succeeding. Without this the
// six `onError` arms in ScheduleView are unreachable — a mock that only ever calls
// `onSuccess` makes an error branch look covered because the file around it is.
// The #2951 gesture's batch. Like `groupTasksMutate`, it can be made to REFUSE and to
// return an EMPTY 207 — the batch endpoint answers 207 with per-row rejections, so
// "request succeeded, nothing applied" is a real outcome the handler has to treat as a
// failure. A mock that only ever applies makes that arm look covered.
let nextBulkCreateError: unknown = null;
let nextBulkCreateApplies = true;
const bulkCreateMutate = vi.fn(
  (
    _ops: unknown[],
    opts?: {
      onSuccess?: (d: {
        applied: { id: string }[];
        rejected: unknown[];
        skipped: unknown[];
        operation_id: string | null;
      }) => void;
      onError?: (e: unknown) => void;
    },
  ) => {
    if (nextBulkCreateError !== null) {
      opts?.onError?.(nextBulkCreateError);
      return;
    }
    opts?.onSuccess?.({
      applied: nextBulkCreateApplies ? [{ id: 'child-1' }] : [],
      rejected: [],
      skipped: [],
      operation_id: nextBulkCreateApplies ? 'op-bulk-1' : null,
    });
  },
);

let nextGroupingError: unknown = null;
const groupTasksMutate = vi.fn(
  (
    vars: { taskIds: string[]; name?: string | null },
    opts?: {
      onSuccess?: (data: Record<string, unknown>) => void;
      onError?: (error: unknown) => void;
    },
  ) => {
    if (nextGroupingError !== null) {
      opts?.onError?.(nextGroupingError);
      return;
    }
    opts?.onSuccess?.({
      container: {
        id: 'container-1',
        name: vars.name ?? 'New phase',
        wbs_path: '1',
        structure_role: 'container',
        parent_id: null,
      },
      grouped_ids: vars.taskIds,
      left_alone: [],
      updated: [],
      warning: null,
      operation_id: 'group-op-1',
    });
  },
);
const ungroupTasksMutate = vi.fn(
  (
    taskId: string,
    opts?: {
      onSuccess?: (data: Record<string, unknown>) => void;
      onError?: (error: unknown) => void;
    },
  ) => {
    if (nextGroupingError !== null) {
      opts?.onError?.(nextGroupingError);
      return;
    }
    opts?.onSuccess?.({
      container_id: taskId,
      lifted_ids: ['t4', 't5'],
      removed_dependency_ids: [],
      updated: [],
      warning: null,
      operation_id: 'ungroup-op-1',
    });
  },
);
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
  // #2997: the view tells the engine when the pointer class moves the row
  // pitch, so the hit index and the paint are re-derived off the new height.
  rowMetricsChanged: vi.fn(),
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
      can_author: serverCanAuthor(),
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
  useCurrentUserRole: () => ({ role: mockRole, isLoading: false, isError: mockRoleError }),
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
    useBulkCreateTasks: () => ({ mutate: bulkCreateMutate, isPending: false }),
    useReorderTasks: () => ({ mutate: reorderTaskMutate, isPending: false, variables: undefined }),
    useAddDependency: () => ({ mutate: addDepMutate, isPending: false, variables: undefined }),
    parseCyclicDependencyError: (err: unknown) =>
      (err as { cyclic?: boolean } | null)?.cyclic ? { path: ['a', 'b'] } : null,
  };
});

vi.mock('@/hooks/useTaskGrouping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskGrouping')>();
  return {
    ...actual,
    useGroupTasks: () => ({ mutate: groupTasksMutate, isPending: false }),
    useUngroupTasks: () => ({ mutate: ungroupTasksMutate, isPending: false }),
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
    onAppendTaskAtEnd,
    onAddPhaseFirstChild,
    appendAtEndReadOnly,
    phaseInWaitingIds,
  }: {
    tasks: Task[];
    onCommitDraftRow?: (name: string, opts?: { onError?: () => void }) => void;
    onAppendTaskAtEnd?: () => void;
    onAddPhaseFirstChild?: (taskId: string) => void;
    appendAtEndReadOnly?: boolean;
    phaseInWaitingIds?: Set<string>;
  }) => (
    <div
      data-testid="task-list-panel"
      data-phase-in-waiting={[...(phaseInWaitingIds ?? [])].sort().join(',')}
    >
      {tasks.map((t) => (
        <div key={t.id}>{t.name}</div>
      ))}
      {onCommitDraftRow && (
        <button type="button" onClick={() => onCommitDraftRow('Pour foundations')}>
          commit-draft
        </button>
      )}
      {/* #2957: the footer's own rendering has its own spec — this stub covers
          ScheduleView's half, that the callback exists at all and appends at the
          top level regardless of the cursor. */}
      {onAppendTaskAtEnd && (
        <button
          type="button"
          data-read-only={appendAtEndReadOnly ? 'true' : 'false'}
          onClick={onAppendTaskAtEnd}
        >
          append-at-end
        </button>
      )}
      {/* The ghost "⊕ Add first item to this phase" affordance lives on
          `TaskListRow`; this stub covers ScheduleView's half — that the create it
          fires announces itself like every other insert (#3018). `t1` is the
          fixture's phase row. */}
      {onAddPhaseFirstChild && (
        <button type="button" onClick={() => onAddPhaseFirstChild('t1')}>
          add-phase-first-child
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
type StubItem = {
  kind: string;
  id: string;
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
};
// The real component takes EITHER a flat `items` list or grouped `sections`
// (#3076). A stub that reads only `items` throws the moment the Schedule
// toolbar starts passing sections — which is exactly what happened, so it
// flattens both here rather than knowing which API the caller used.
vi.mock('@/components/toolbar/ToolbarOverflowMenu', () => ({
  ToolbarOverflowMenu: ({
    triggerAriaLabel,
    items,
    sections,
  }: {
    triggerAriaLabel: string;
    items?: StubItem[];
    sections?: { id: string; label: string; items: StubItem[] }[];
  }) => (
    <div role="group" aria-label={triggerAriaLabel}>
      {(sections ? sections.flatMap((s) => s.items) : (items ?? [])).map((it) =>
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
import { ScheduleView, schedulePanelWidth, scheduleOutlineRendered } from './ScheduleView';

/**
 * The Schedule's transient status surface (toast / export progress).
 *
 * ScheduleView legitimately holds more than one `role="status"` node since
 * ADR-0784 added the always-mounted reconciliation live region — and a second
 * since #3018 gave the outline's structural-act region its declared `role`.
 * A bare `getByRole('status')` is therefore ambiguous. Exclude the other two by
 * testid rather than loosening the assertion; `getActLiveRegion` below is how a
 * test reaches the structural-act one on purpose.
 */
function getScheduleStatus(): HTMLElement {
  const regions = screen
    .getAllByRole('status')
    .filter(
      (n) =>
        n.getAttribute('data-testid') !== 'reconcile-live' &&
        n.getAttribute('data-testid') !== 'schedule-act-live' &&
        // The toolbar's demotion announcer (#3076) — mounted unconditionally
        // so the region is already in the a11y tree when its text changes, so
        // it is always present and never the one these tests mean.
        n.getAttribute('data-testid') !== 'schedule-demotion-live',
    );
  expect(regions).toHaveLength(1);
  return regions[0];
}

/**
 * The outline's structural-act live region (#2948, #3018).
 *
 * Every structural gesture routes one sentence through here. Located by its
 * declared `role="status"` — which is the contract #3018 restored — rather than
 * by scraping every `[aria-live="polite"]` node on the screen, which is what a
 * test had to do while the role was missing.
 */
function getActLiveRegion(): HTMLElement {
  return screen.getByTestId('schedule-act-live');
}


/**
 * Turn on the Phase / Group / Ungroup toolbar buttons (#2955).
 *
 * They ship **off** — `⌥⌘G` and `⇥` already make phases, so the #2959 persona panel took
 * the leaner reading — and the preference is per-user, per-project `localStorage`. A test
 * that asserts on those buttons therefore opts in the same way a user does through the
 * Display menu's Outline section. Call before `renderSchedule`: the hook hydrates once.
 */
function enableStructureButtons(): void {
  window.localStorage.setItem(
    'trueppm.schedule.displayOptions.test-user-1.project-1',
    JSON.stringify({ structureButtons: true }),
  );
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
  mockCanAuthorOverride = undefined;
  mockRoleError = false;
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
  // Same reason as `reorderTaskMutate` below: uncleared, one test's `mock.calls[0]`
  // is an earlier test's call, and a "was not called" assertion reads the leak.
  bulkCreateMutate.mockClear();
  nextBulkCreateError = null;
  nextBulkCreateApplies = true;
  // Never cleared before #3018, so `reorderTaskMutate.mock.calls[0]` in one test was
  // an EARLIER test's call — whose captured `onError` closes over an unmounted
  // render's live-region ref. The trail (a module singleton) still recorded, so the
  // leak read as "the sentence reached the trail but not the screen reader".
  reorderTaskMutate.mockClear();
  nextCreateTaskFails = false;
  createTaskCounter = 0;
  deleteTaskMutate.mockReset();
  groupTasksMutate.mockClear();
  ungroupTasksMutate.mockClear();
  nextGroupingError = null;
  // The trail is a module singleton — a previous test's act would otherwise be
  // counted as this one's.
  useTrailStore.getState().clear();
  // Display options persist per-user per-project (#2955), so `enableStructureButtons`
  // in one test would otherwise make the default-off assertion in another pass
  // vacuously — the failure mode that hides a ruling nobody re-checks.
  window.localStorage.removeItem('trueppm.schedule.displayOptions.test-user-1.project-1');
  // Author/Read also persists per-user per-project. Three describes already cleared it
  // in their own `beforeEach`; a test that toggles the pill anywhere else silently put
  // every LATER test in the file into Read mode, which reads as eight unrelated
  // failures. Clearing it once here is the version that cannot be forgotten.
  window.localStorage.removeItem('trueppm.schedule.authorMode.test-user-1.project-1');
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
    expect(screen.getByRole('columnheader', { name: 'Item' })).toBeInTheDocument();
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
    // #2733 deleted the "No items yet / Add first item" card. A card is a thing
    // you must dismiss before you can work; the outline now opens with the caret
    // already in row 1, so the first keystroke is the first task.
    const user = userEvent.setup();
    mockTasks = [];
    mockLinks = [];
    renderSchedule();

    await user.click(screen.getByRole('button', { name: 'commit-draft' }));

    // The draft row now routes through the same create shape as the outline's
    // own insert (#2952): `parent_id` from the insertion point, and an
    // `onError` so a failed create on a blank project is not silent.
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pour foundations', duration: 1, parent_id: null }),
      expect.objectContaining({ onError: expect.any(Function) as unknown }),
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
    expect(screen.queryByText(/no items yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Sprints' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
    // …and no outline beside it (#2960). The card says this view does not apply
    // to this project; a live draft row next to it would invite the author to
    // fill in a form the card just said is not part of their workflow.
    expect(screen.queryByTestId('task-list-panel')).toBeNull();
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
    // The counterpart to the AGILE case above: an empty NON-agile project keeps
    // its outline, so the AGILE suppression cannot regress into "never render
    // the panel when empty" with both tests still green (#2960).
    expect(screen.getByTestId('task-list-panel')).toBeInTheDocument();
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
    const addBtn = screen.getByRole('button', { name: 'Add item' });
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

  it('creates a task and wraps it into a phase from the "+ Phase" button (#2955)', async () => {
    const user = userEvent.setup();
    enableStructureButtons();
    renderSchedule();
    await user.click(screen.getByRole('button', { name: '+ Phase' }));
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New item' }),
      expect.anything(),
    );
    expect(groupTasksMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Untitled phase' }),
      expect.anything(),
    );
  });

  it('hides the three structure buttons until the Display option turns them on (#2955)', () => {
    // The default is a ruling, not an omission: ⌥⌘G and ⇥ already make phases, so the
    // buttons are the discoverable route rather than permanent toolbar width. A ruling
    // nothing asserts is one the next toolbar change quietly reverses.
    renderSchedule();
    expect(screen.queryByRole('button', { name: '+ Phase' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-rows-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ungroup-rows-button')).not.toBeInTheDocument();
    // "+ Task" and "+ Milestone" are NOT part of the gated group.
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
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
    enableStructureButtons();
    renderSchedule();
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '+ Phase' })).toBeEnabled();
  });

  it('gives a viewer no Group / Ungroup even with the Display option on (#2949, rule 302)', () => {
    // The option governs *chrome*, never rights. Absence, not a disabled control.
    mockRole = ROLE_VIEWER;
    enableStructureButtons();
    renderSchedule();
    expect(screen.queryByTestId('group-rows-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ungroup-rows-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Phase' })).not.toBeInTheDocument();
  });
});

describe('ScheduleView — three insert affordances (#2957)', () => {
  beforeEach(() => {
    window.localStorage.removeItem('trueppm.schedule.authorMode.test-user-1.project-1');
  });

  it('appends at the TOP level from the footer, whatever the cursor is on', async () => {
    // The whole defect: a control at the foot of the list that quietly did the
    // cursor's bidding. `t3` is a child of the `t1` summary, so an affordance
    // that honored the selection would post `parent_id: 't1'`.
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    act(() => {
      useScheduleStore.setState({ selectedTaskId: 't3' });
    });
    await user.click(screen.getByRole('button', { name: 'append-at-end' }));
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ parent_id: null }),
      expect.anything(),
    );
  });

  it('gives a viewer no footer at all — absent, not disabled', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    expect(screen.queryByRole('button', { name: 'append-at-end' })).not.toBeInTheDocument();
  });

  it('keeps the footer present and inert for an editor who chose Read', async () => {
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    expect(screen.getByRole('button', { name: 'append-at-end' })).toHaveAttribute(
      'data-read-only',
      'true',
    );
  });

  it('refuses the append in Read mode even if the control is reached', async () => {
    // The stub button is not disabled, so the click reaches the handler — which
    // is the point: the guard, not the styling, is what stops the write.
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    createTaskMutate.mockClear();
    await user.click(screen.getByRole('button', { name: 'append-at-end' }));
    expect(createTaskMutate).not.toHaveBeenCalled();
  });

  it('states nothing and opens the create form when nothing is focused', async () => {
    // No focused row means no row to land after — the toolbar says so by saying
    // nothing, rather than borrowing the footer's append-at-the-end behavior.
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    expect(screen.queryByTestId('schedule-insert-target')).not.toBeInTheDocument();
    const addBtn = screen.getByRole('button', { name: 'Add item' });
    expect(addBtn).toHaveAttribute('aria-expanded', 'false');
    await user.click(addBtn);
    expect(screen.getByRole('dialog', { name: 'Task form' })).toBeInTheDocument();
  });
});

describe('ScheduleView — ?author= deep link (#2952)', () => {
  it('creates a task from ?author=task for an editor', () => {
    mockRole = ROLE_MEMBER;
    renderSchedule(['/?author=task']);
    expect(createTaskMutate).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it('spends ?author=task without creating anything for a viewer', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule(['/?author=task']);
    expect(createTaskMutate).not.toHaveBeenCalled();
  });

  // The regression rule 246 (query-error-unhandled) caught: `useCurrentUserRole`
  // sets `isLoading: false` once a `retry: false` read fails, so gating only on
  // `isLoading` reads a blipped request as "resolved: read-only" — the link
  // gets marked spent and consumed forever, identically to the #2909/#2961
  // defect this same hook exists to prevent elsewhere in ScheduleView.
  it('does not spend ?author=task on a failed role read — the link survives to the next resolved render (#2909, #2961)', () => {
    mockRole = null;
    mockRoleError = true;
    const { rerender } = renderSchedule(['/?author=task']);

    expect(createTaskMutate).not.toHaveBeenCalled();

    // The blip clears (e.g. a fresh mount re-queries). Because the failed read
    // was never treated as a verdict, the link is still live.
    mockRole = ROLE_MEMBER;
    mockRoleError = false;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/?author=task']}>
          <ScheduleView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(createTaskMutate).toHaveBeenCalled();
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
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(before + 16);
  });

  it('nudges the task-list width left by 16px on ArrowLeft', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(before - 16);
  });

  it('jumps to the min width on Home and the max width on End', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(600);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(120);
  });

  it('ignores non-resize keys (no width change)', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
    const before = sep.getAttribute('aria-valuenow');
    fireEvent.keyDown(sep, { key: 'a' });
    expect(sep.getAttribute('aria-valuenow')).toBe(before);
  });

  it('resizes via a pointer drag (down → move updates aria-valuenow)', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
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

  // #2960: before this the POINTER path was unbounded — only the keyboard
  // clamped. On the Grid a runaway drag merely looked untidy beside five data
  // columns; on the Timeline the outline is the only thing left of the bar
  // track, so it pushes the entire surface off the viewport with nothing to
  // grab. Both cases below fail against origin/main.
  it('clamps a runaway pointer drag at both ends', () => {
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
    sep.setPointerCapture = vi.fn();

    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 10_000 });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(600);
    fireEvent.pointerMove(sep, { clientX: -10_000 });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(120);
    fireEvent.pointerUp(sep);
  });

  it('announces the bound it actually enforces', () => {
    // jsdom measures the container as 0, which `maxTaskWidthFor` reads as
    // "not laid out yet" and answers with the absolute ceiling rather than
    // collapsing the column — so the announced max is 600 here, and tracks the
    // narrower bar-track floor in a real viewport.
    window.localStorage.clear();
    renderSchedule();
    const sep = screen.getByRole('separator', { name: 'Resize item list panel' });
    expect(sep).toHaveAttribute('aria-valuemax', '600');
    expect(sep).toHaveAttribute('aria-valuemin', '120');
  });
});

describe('the outline predicate and the overlay offset (#2960)', () => {
  // The legend, the unscheduled gutter and the milestone pulse are positioned by
  // adding this number to their left edge. Before #2960 it was
  // `viewMode === 'timeline' ? 0 : …` because Timeline genuinely had no outline
  // panel. Now ONE predicate answers "is a panel on screen at all?" and feeds
  // both the render guard and this offset — the two disagreeing is invisible,
  // because it parks the legend in the middle of the surface with nothing
  // looking broken, and no e2e that measures the OUTLINE's box can see it.
  it('offsets by the outline when one is rendered, and by nothing when none is', () => {
    expect(schedulePanelWidth(true, 268)).toBe(268);
    expect(schedulePanelWidth(true, 600)).toBe(600);
    expect(schedulePanelWidth(false, 268)).toBe(0);
  });

  it('renders no outline on mobile, nor on an AGILE project with nothing scheduled', () => {
    // Mobile returns the dedicated MobileSchedule surface (#1670) — no panel.
    expect(scheduleOutlineRendered(true, 12, 'HYBRID')).toBe(false);
    // An AGILE project with no schedule gets the methodology card full-width: a
    // live draft row beside it would invite the author to fill in a form the
    // card just said is not part of their workflow.
    expect(scheduleOutlineRendered(false, 0, 'AGILE')).toBe(false);
    // Everything else keeps its outline — including an EMPTY non-agile project,
    // whose blank-canvas state is a live draft row plus the fill options (#2733).
    expect(scheduleOutlineRendered(false, 0, 'HYBRID')).toBe(true);
    expect(scheduleOutlineRendered(false, 12, 'AGILE')).toBe(true);
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

describe('ScheduleView — mod+alt+p phase authoring binding (#2955)', () => {
  it('creates the first TASK and then wraps it, so no empty phase can be left behind', () => {
    renderSchedule();
    const preventDefault = vi.fn();
    const e = { preventDefault } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+alt+p']?.(e));
    expect(preventDefault).toHaveBeenCalled();
    // The create is a plain task — the container comes from `tasks/group/`, which is
    // what makes it a *declared* container (#2950) and one undo step (#2974).
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New item' }),
      expect.anything(),
    );
    expect(groupTasksMutate).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ['new-task-1'], name: 'Untitled phase' }),
      expect.anything(),
    );
  });

  it('adopts the FOCUSED leaf as the container, in ONE batch call (#2951)', () => {
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t2'));
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+alt+p']?.(e));

    // One call, one op — the whole claim of the issue. A `create` naming the focused row
    // as parent is all it takes: the server declares that parent a container on the same
    // write (#3036), so no empty container exists at any point and there is no second
    // round trip in which the wrap could fail.
    expect(bulkCreateMutate).toHaveBeenCalledTimes(1);
    const ops = bulkCreateMutate.mock.calls[0][0] as {
      op: string;
      id: string;
      data: Record<string, unknown>;
    }[];
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('create');
    expect(ops[0].data).toMatchObject({ parent_id: 't2', duration: 1 });
    // The client mints the id (ADR-0772), which is what lets the caret move to the child
    // without waiting for the row to come back.
    expect(ops[0].id).toEqual(expect.any(String));

    // The old two-call path must NOT also run — that would be two undo steps and a
    // window in which an empty container exists, which is what this replaces.
    expect(createTaskMutate).not.toHaveBeenCalled();
    expect(groupTasksMutate).not.toHaveBeenCalled();
  });

  it('falls back to create-then-wrap when NOTHING is focused (#2951)', () => {
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+alt+p']?.(e));
    // No row to adopt, so the gesture still means "make a new phase here" — the
    // pre-existing behavior, unchanged.
    expect(bulkCreateMutate).not.toHaveBeenCalled();
    expect(createTaskMutate).toHaveBeenCalled();
  });

  it('does not adopt a row that is ALREADY a container (#2951)', () => {
    // A summary has no transition to make; adopting it would be a plain "add a child",
    // which Enter already does. Asserted because the predicate is the whole gesture: a
    // wrong one silently turns ⌘⌥P into a second insert key.
    mockTasks = [
      { ...FIXTURE_TASKS[0], id: 'sum-1', name: 'Already a phase', isSummary: true },
    ];
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('sum-1'));
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+alt+p']?.(e));
    expect(bulkCreateMutate).not.toHaveBeenCalled();
    expect(createTaskMutate).toHaveBeenCalled();
  });

  it('treats an EMPTY 207 as a failure rather than reporting a phase (#2951)', () => {
    // The batch answers 207 with per-row rejections, so "the request succeeded and
    // nothing was applied" is a real outcome. Reporting a phase here would be rule 301's
    // failure with the worst payload: a confident, wrong account of the user's plan.
    nextBulkCreateApplies = false;
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t2'));
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+alt+p']?.(e));
    expect(bulkCreateMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Couldn't add a task under/)).toBeInTheDocument();
    nextBulkCreateApplies = true;
  });

  it('no longer claims ⌘P, which is the browser’s Print (ADR-0627)', () => {
    renderSchedule();
    expect(capturedKeyBindings['mod+p']).toBeUndefined();
  });

  it('keeps the task and explains itself when the create lands but the wrap does not', () => {
    // The branch the create-then-group inversion exists for. A failed wrap leaves an
    // ordinary task — benign — but only if the user is told, and only if the caret goes
    // to the row that actually exists rather than to a container that does not.
    nextGroupingError = new TaskGroupingRefused({ code: 'selection_too_large', detail: 'x' });
    renderSchedule();
    act(() => capturedKeyBindings['mod+alt+p']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(createTaskMutate).toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      'too many rows to wrap',
    );
    expect(capturedBuildMode!.focus.state.rowId).toBe('new-task-1');
  });

  it('is a no-op for a read-only viewer', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    const e = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => capturedKeyBindings['mod+alt+p']?.(e));
    expect(createTaskMutate).not.toHaveBeenCalled();
    expect(groupTasksMutate).not.toHaveBeenCalled();
  });
});

describe('ScheduleView — phase-in-waiting after #2955', () => {
  it('reads a DECLARED container with no work in it as a phase-in-waiting', () => {
    // `+ Phase` no longer writes the client-side marker — it creates the phase *with*
    // its first task, so there is never a moment of waiting — which would have left the
    // ghost affordance unreachable. The state is still real and now arrives as a server
    // fact: delete the last task out of a grouped phase and `structure_role` stays
    // `container` (`auto_container: false`, #2950) rather than demoting back to work.
    mockTasks = [
      {
        ...FIXTURE_TASKS[0],
        id: 'emptied-phase',
        name: 'Emptied phase',
        wbs: '9',
        parentId: null,
        isSummary: false,
        isPhase: false,
        structureRole: 'container',
      },
    ];
    renderSchedule();
    expect(screen.getByTestId('task-list-panel')).toHaveAttribute(
      'data-phase-in-waiting',
      'emptied-phase',
    );
  });

  it('does not read ordinary work as one', () => {
    mockTasks = [
      { ...FIXTURE_TASKS[0], id: 'plain', name: 'Plain', wbs: '9', parentId: null, structureRole: 'work' },
    ];
    renderSchedule();
    expect(screen.getByTestId('task-list-panel')).toHaveAttribute('data-phase-in-waiting', '');
  });
});

describe('ScheduleView — Group / Ungroup keybindings (#2955)', () => {
  it('registers neither chord outside build mode — the selection they act on only exists there', () => {
    mockMobile = true;
    renderSchedule();
    expect(capturedKeyBindings['mod+alt+g']).toBeUndefined();
    expect(capturedKeyBindings['mod+shift+alt+g']).toBeUndefined();
  });

  it('⌥⌘G sends the multi-row selection in visible order', () => {
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedBuildMode!.focus.selectIds(['t3', 't1']));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(groupTasksMutate).toHaveBeenCalledTimes(1);
    const [vars] = groupTasksMutate.mock.calls[0] as [{ taskIds: string[]; name?: string | null }];
    // Visible order, not Set insertion order — the server's majority-parent tie-break
    // is defined on request order.
    expect(vars.taskIds).toEqual(['t1', 't3']);
    // No name: the design names the phase LAST.
    expect(vars.name).toBeUndefined();
  });

  it('⌥⌘G falls back to the focused row — wrapping one row is a legal group', () => {
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t2'));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(groupTasksMutate).toHaveBeenCalledTimes(1);
    expect(
      (groupTasksMutate.mock.calls[0] as [{ taskIds: string[] }])[0].taskIds,
    ).toEqual(['t2']);
  });

  it('⌥⌘G STATES its refusal with nothing selected rather than doing nothing (rule 311)', () => {
    renderSchedule();
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(groupTasksMutate).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      'select the rows you want to wrap',
    );
  });

  it('⌥⇧⌘G refuses on a row that is not a phase, and points at outdent instead', () => {
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t2'));
    act(() =>
      capturedKeyBindings['mod+shift+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent),
    );
    expect(ungroupTasksMutate).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      `${formatChord('alt+ArrowLeft')} to outdent a single row`,
    );
  });

  it('explains the refusal to an EDITOR in Read, and stays silent for a viewer (rule 302)', async () => {
    // The two states rule 302 keeps apart, on the same guard. One key gets the editor
    // back, so the chord explains itself; the viewer was never offered the control, so
    // explaining a refusal to them is noise about a button they cannot see.
    const user = userEvent.setup();
    renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(groupTasksMutate).not.toHaveBeenCalled();
    // Asserted through the formatter, not a literal: the toast is spelled for the
    // reader's platform (#3028), so a hardcoded glyph would pin the Mac branch and
    // fail everywhere else — which is the defect, not the test.
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      `press ${formatChord('alt+a')} to author`,
    );
  });

  it('stays silent for a viewer — no offer, so nothing to explain (rule 302)', () => {
    mockRole = ROLE_VIEWER;
    renderSchedule();
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    act(() =>
      capturedKeyBindings['mod+shift+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent),
    );
    expect(groupTasksMutate).not.toHaveBeenCalled();
    expect(ungroupTasksMutate).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
  });

  it('⌥⇧⌘G dissolves the focused phase and leaves ONE reversible trail entry', () => {
    renderSchedule();
    // `t1` is a summary with children in the fixture, so it resolves as a phase.
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() =>
      capturedKeyBindings['mod+shift+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent),
    );
    expect(ungroupTasksMutate).toHaveBeenCalledTimes(1);
    expect((ungroupTasksMutate.mock.calls[0] as [string])[0]).toBe('t1');
    const entries = useTrailStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('is no longer a phase');
    expect(entries[0].operationId).toBe('ungroup-op-1');
  });

  it('speaks the FULL outcome to the live region while the trail keeps the short form', () => {
    // The notice strip is deliberately not a live region, so this channel is the only
    // one a screen-reader user has. Dropping `flattenOutcome` here would silently strip
    // `left_alone` and the warning from it and nothing else would notice.
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedBuildMode!.focus.selectIds(['t1', 't3']));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    // The outline's region carries `role="status"` since #3018, so it can be reached
    // directly instead of by scraping every polite region on the screen and hoping the
    // right one comes first in the DOM.
    const spoken = getActLiveRegion().textContent ?? '';
    expect(spoken).toContain('2 items are now a phase.');
    expect(spoken).toContain('roll up from the work inside');
    // …and the trail keeps the scannable one.
    expect(useTrailStore.getState().entries[0].text).toBe('2 items are now a phase.');
  });

  it('says which RULE a refused group hit, rather than a generic failure', () => {
    nextGroupingError = new TaskGroupingRefused({
      code: 'nothing_to_group',
      detail: 'server sentence the client does not use',
    });
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      'sits inside another one you selected',
    );
    // A refusal wrote nothing, so it must leave no outcome strip claiming otherwise.
    expect(useTrailStore.getState().entries).toHaveLength(0);
  });

  it('falls back to a plain sentence when the failure is not a stated refusal', () => {
    nextGroupingError = new Error('network');
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
      'Couldn’t group those rows. Nothing changed.',
    );
  });

  it('says the same for a refused ungroup', () => {
    nextGroupingError = new TaskGroupingRefused({
      code: 'container_has_subtasks',
      detail: 'x',
    });
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() =>
      capturedKeyBindings['mod+shift+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent),
    );
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      'carries subtasks',
    );
    expect(useTrailStore.getState().entries).toHaveLength(0);
  });

  it('a group leaves ONE trail entry carrying the ledger handle, so ⌘Z reverses it whole', () => {
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedBuildMode!.focus.selectIds(['t1', 't3']));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    const entries = useTrailStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('2 items are now a phase.');
    expect(entries[0].operationId).toBe('group-op-1');
  });
});

/**
 * Insert — the fourth structural act, and the one that announced nothing (#3018).
 *
 * The suite above covered indent, outdent, drag and delete and was green while
 * insert — the most frequent gesture on this surface — routed no sentence and left
 * no trail entry, because `insertSentence` was written and imported by nothing.
 * These cases exist so that a path which creates a row without saying so fails here
 * rather than shipping. All four are asserted individually on purpose: the four
 * gestures land a row in four different places, and a shared assertion would let
 * three of them regress behind the one that still passes.
 */
describe('ScheduleView — insert announces and is recorded (#3018)', () => {
  it('names where an ⏎ sibling landed, to both audiences', () => {
    // `t2` (1.1) is focused, but the create endpoint appends at the END of the
    // parent's children — so the row follows `t6` (1.5), and naming the focused
    // row would be the more flattering claim and a false one. Same rule the
    // toolbar's own statement already follows (#2957).
    renderSchedule();
    act(() => capturedBuildMode!.insertBelow('t2'));
    const sentence = 'New item added below Go-Live, at the same level.';
    // Trail first, then the live region: the trail assertion needs no locator, so
    // when this regresses the failure names the missing record rather than a
    // missing test id.
    const entries = useTrailStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe(sentence);
    expect(getActLiveRegion()).toHaveTextContent(sentence);
  });

  it('says ABOVE for ⇧⏎ — the half of the act the user cannot infer from the caret', () => {
    // insertAbove composes create + reorder; "below" here would describe the
    // wrong neighbour and be a sentence a user could check and find false.
    renderSchedule();
    act(() => capturedBuildMode!.insertAbove('t2'));
    const sentence = 'New item added above Discovery & Design, at the same level.';
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual([sentence]);
    expect(getActLiveRegion()).toHaveTextContent(sentence);
  });

  it('names the new parent for ⌘⏎, not a sibling', () => {
    renderSchedule();
    act(() => capturedBuildMode!.insertChild('t1'));
    const sentence = 'New item added under Alpha Platform Upgrade.';
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual([sentence]);
    expect(getActLiveRegion()).toHaveTextContent(sentence);
  });

  it('names the LEVEL for the footer append, which has no anchor row', async () => {
    // The foot of the plan is not inside anything, so there is no neighbour to
    // name — and inventing one from the cursor is the #2957 defect.
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    act(() => {
      useScheduleStore.setState({ selectedTaskId: 't3' });
    });
    await user.click(screen.getByRole('button', { name: 'append-at-end' }));
    const sentence = 'New item added at the end of the plan, at the top level.';
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual([sentence]);
    expect(getActLiveRegion()).toHaveTextContent(sentence);
  });

  it('writes nothing when the server refuses the create', () => {
    // The property the four cases above cannot prove on their own: the sentence
    // is bound to SUCCESS, not to the keystroke. A trail entry for a row that was
    // never created is worse than no entry — it is a record that is wrong.
    nextCreateTaskFails = true;
    renderSchedule();
    act(() => capturedBuildMode!.insertBelow('t2'));
    expect(createTaskMutate).toHaveBeenCalled();
    expect(useTrailStore.getState().entries).toHaveLength(0);
    expect(getActLiveRegion()).toHaveTextContent('');
  });

  it('carries the declared role="status" on the region every structural act speaks through', () => {
    renderSchedule();
    expect(getActLiveRegion()).toHaveAttribute('role', 'status');
    expect(getActLiveRegion()).toHaveAttribute('aria-live', 'polite');
  });

  it('tells the user when the create itself failed, rather than failing silently', () => {
    // The complement to the case above: "nothing was recorded" is only correct if the
    // user is told SOMETHING. Without this, reducing `onError` to a no-op keeps the
    // trail assertion green while the create fails in silence.
    nextCreateTaskFails = true;
    renderSchedule();
    act(() => capturedBuildMode!.insertBelow('t2'));
    expect(toastError).toHaveBeenCalledWith("Couldn't add a new task — try again.");
  });

  it('re-announces an identical sentence, which a repeated insert always produces', () => {
    // A live region rewritten with the SAME string is not a mutation and most screen
    // readers stay silent. Repetition is insert's NORMAL usage — the footer's sentence
    // never varies at all — so without this the fix's whole benefit stops at row one.
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    return (async () => {
      await user.click(screen.getByRole('button', { name: 'append-at-end' }));
      const first = getActLiveRegion().textContent;
      await user.click(screen.getByRole('button', { name: 'append-at-end' }));
      const second = getActLiveRegion().textContent;
      // Both say the same thing to a reader…
      expect(first).toContain('New item added at the end of the plan');
      expect(second).toContain('New item added at the end of the plan');
      // …and are different NODES to the accessibility tree, which is what makes the
      // second one audible.
      expect(second).not.toBe(first);
      expect(useTrailStore.getState().entries).toHaveLength(2);
    })();
  });

  it('does not become an undo BARRIER for the reversible act behind it', () => {
    // The regression this exists to stop: `newestUndoableEntry` walks back from the
    // newest entry and STOPS at the first one with no ledger handle. An insert has no
    // ledger row, so recording it naively would kill ⌘Z — and the trail's Undo button
    // with it — for the whole session, from the surface's most frequent gesture.
    renderSchedule();
    act(() => capturedBuildMode!.focus.focusRow('t1'));
    act(() => capturedBuildMode!.focus.selectIds(['t1', 't3']));
    act(() => capturedKeyBindings['mod+alt+g']?.({ preventDefault: vi.fn() } as unknown as KeyboardEvent));
    act(() => capturedBuildMode!.insertBelow('t2'));

    const entries = useTrailStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[1].blocksUndo).toBe(false);
    // The group behind it is still what ⌘Z would reverse.
    expect(newestUndoableEntry(entries)?.operationId).toBe('group-op-1');
  });

  it('corrects itself out loud when ⇧⏎ created the row but could not place it', () => {
    // "Added above X" is two requests; only the reorder makes it true. A silent
    // failure would leave a spoken claim and a permanent trail entry that are both
    // false — worse than the pre-#3018 silence, not better.
    renderSchedule();
    act(() => capturedBuildMode!.insertAbove('t2'));
    const reorderOpts = reorderTaskMutate.mock.calls[0]?.[1] as
      | { onError?: (e: unknown) => void }
      | undefined;
    expect(reorderOpts?.onError).toBeTypeOf('function');
    act(() => reorderOpts!.onError!(new Error('reorder refused')));

    const texts = useTrailStore.getState().entries.map((e) => e.text);
    expect(texts[0]).toBe('New item added above Discovery & Design, at the same level.');
    expect(texts[1]).toContain('couldn’t place it above Discovery & Design');
    expect(getActLiveRegion()).toHaveTextContent('couldn’t place it above');
    expect(useScheduleStore.getState().scheduleActionToast?.message).toContain(
      'end of that level',
    );
  });
});

/**
 * The two row-creating paths that do NOT go through `createNewTask` (#3018).
 *
 * They are the reason the required-`sentence` argument is a guard and not a proof:
 * it binds that helper's callers, and a direct `createTaskMut.mutate` sits outside
 * it. Both create a structural row, so both say so.
 */
describe('ScheduleView — the creates that bypass createNewTask still announce (#3018)', () => {
  it('announces the ghost "add first item to this phase" affordance', async () => {
    const user = userEvent.setup();
    mockRole = ROLE_MEMBER;
    renderSchedule();
    await user.click(screen.getByRole('button', { name: 'add-phase-first-child' }));
    const sentence = 'New item added under Alpha Platform Upgrade.';
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual([sentence]);
    expect(getActLiveRegion()).toHaveTextContent(sentence);
  });

  it('announces the blank-project draft row, the one screen with no other act', async () => {
    const user = userEvent.setup();
    mockTasks = [];
    mockLinks = [];
    mockRole = ROLE_MEMBER;
    renderSchedule();
    await user.click(screen.getByRole('button', { name: 'commit-draft' }));
    const sentence = 'New item added at the end of the plan, at the top level.';
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual([sentence]);
    expect(getActLiveRegion()).toHaveTextContent(sentence);
  });

  it('records nothing for a draft row the server refused', () => {
    nextCreateTaskFails = true;
    mockTasks = [];
    mockLinks = [];
    mockRole = ROLE_MEMBER;
    renderSchedule();
    act(() => {
      screen.getByRole('button', { name: 'commit-draft' }).click();
    });
    expect(useTrailStore.getState().entries).toHaveLength(0);
  });
});

/**
 * `?author=task` (#2952) is the fifth caller of `createNewTask` and the only one whose
 * sentence branches at runtime — so it is the one most likely to be wrong, and it was
 * asserted by nothing (#3018). It is also the only insert the user did not watch land,
 * which is why naming a row that is not there would be the worst failure here.
 */
describe('ScheduleView — the ?author=task deep link announces where it landed (#3018)', () => {
  it('names the container when the link names one', () => {
    mockRole = ROLE_MEMBER;
    renderSchedule([`/?author=task&${AUTHOR_PARENT_PARAM}=t1`]);
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual([
      'New item added under Alpha Platform Upgrade.',
    ]);
  });

  it('falls back to the anchorless sentence rather than naming "Untitled"', () => {
    // A stale or foreign `parent` id — and the same shape as the tasks query not
    // having resolved. `actRow` would render `{ name: '' }` as "Untitled", which
    // names a row that is not there.
    mockRole = ROLE_MEMBER;
    renderSchedule([`/?author=task&${AUTHOR_PARENT_PARAM}=no-such-row`]);
    const texts = useTrailStore.getState().entries.map((e) => e.text);
    expect(texts).toEqual(['New item added at the end of the plan, at the top level.']);
    expect(texts[0]).not.toContain('Untitled');
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
    expect(screen.queryByRole('button', { name: '+ Add item' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'commit-draft' }));
    expect(createTaskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pour foundations', duration: 1, parent_id: null }),
      expect.objectContaining({ onError: expect.any(Function) as unknown }),
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
    enableStructureButtons();
    renderSchedule();
    await user.click(screen.getByTestId('author-mode-pill'));
    expect(screen.getByTestId('author-mode-pill')).toHaveTextContent('Read');
    expect(screen.getByRole('button', { name: '+ Milestone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Phase' })).toBeDisabled();
    // Present and inert, not absent — one key gets this editor back (#2949).
    expect(screen.getByTestId('group-rows-button')).toBeDisabled();
    expect(screen.getByTestId('ungroup-rows-button')).toBeDisabled();
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

describe('ScheduleView — the authoring gate is the server\'s can_author (#3034)', () => {
  // ADR-0773 §(d) names `ProjectSerializer.can_author` "the web gate", and the
  // Designer ignored it: `hasEditRights` was `canEditTask(currentRole)`, a plain
  // `role >= ROLE_MEMBER` test. ROLE_SCHEDULER (200) passes that and is refused
  // by the server, so a Scheduler was handed the full apparatus and then refused
  // two different ways — paste-many 403s outright, while a single row COMMITS and
  // every subsequent keystroke 403s.
  //
  // The `mockRole` in these tests stays SCHEDULER on purpose. That is what makes
  // them a regression net: they only pass while the gate reads the server field,
  // and go red the moment anyone re-derives it from the ordinal.

  it('a Scheduler sees the same absence a Viewer sees — no pill, no insert, no apparatus', () => {
    mockRole = ROLE_SCHEDULER;
    renderSchedule();
    expect(screen.queryByTestId('author-mode-pill')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Milestone' })).not.toBeInTheDocument();
    expect(screen.getByTestId('schedule-view-only')).toBeInTheDocument();
  });

  it('a Scheduler still reads the schedule — this hides authoring, not data', () => {
    mockRole = ROLE_SCHEDULER;
    renderSchedule();
    // Read access is untouched: the rows and the forecast are both present. The
    // #2949 rule is "the authoring apparatus is absent", not "the view is empty".
    expect(screen.getByTestId('forecast-bar')).toBeInTheDocument();
  });

  it('a Member is unaffected — the band exclusion is not a raised floor', () => {
    mockRole = ROLE_MEMBER;
    renderSchedule();
    expect(screen.getByTestId('author-mode-pill')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-view-only')).not.toBeInTheDocument();
  });

  it('withholds the apparatus until the project detail resolves', () => {
    // `can_author` absent (the query has not landed) reads as "no", so the pill
    // never flashes on for the non-author majority and then vanishes. The role
    // says ADMIN in BOTH halves precisely to show it is the project query — not
    // the role query — that the gate now waits on.
    mockRole = ROLE_ADMIN;
    mockCanAuthorOverride = 'unresolved';
    renderSchedule();
    expect(screen.queryByTestId('author-mode-pill')).not.toBeInTheDocument();
    expect(screen.getByTestId('schedule-view-only')).toBeInTheDocument();

    cleanup();
    mockCanAuthorOverride = undefined; // resolved; derives true from ROLE_ADMIN
    renderSchedule();
    expect(screen.getByTestId('author-mode-pill')).toBeInTheDocument();
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
