import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { SprintsView } from './SprintsView';
import { makeSprint } from './sprintTestFixtures';
import type { MyActiveSprintEntry } from '@/hooks/useMyActiveSprints';

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: vi.fn(() => 'proj-1'),
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'proj-1', name: 'Alpha Platform', methodology: 'AGILE' },
    isLoading: false,
    error: null,
  })),
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

vi.mock('@/hooks/useSprints', () => ({
  useSprints: (projectId?: string | null) => useSprintsMock(projectId),
  useSprintsByState: (projectId?: string | null) => useSprintsByStateMock(projectId),
  useSprintMutations: (projectId?: string | null) => useSprintMutationsMock(projectId),
  useSprintBurndown: () => ({ data: undefined, isLoading: false, error: null }),
  useSprintCapacity: () => ({ data: undefined, isLoading: false, error: null }),
  useProjectVelocity: () => ({ data: undefined, isLoading: false, error: null }),
  // #988: GuardrailHealthBadges renders server-owned signals; default to empty.
  useSprintHealth: () => ({ data: { signals: [] }, isLoading: false, error: null }),
  useSprintOutcome: () => ({ data: undefined, isLoading: false, error: null }),
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
}));

const useMyActiveSprintsMock = vi.fn(() => ({
  data: [] as Array<{ project_id: string; project_name: string }>,
  isLoading: false,
  error: null,
}));

vi.mock('@/hooks/useMyActiveSprints', () => ({
  useMyActiveSprints: () => useMyActiveSprintsMock(),
}));

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
  TaskDetailDrawer: () => <div role="dialog" aria-label="Task detail" />,
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
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
    });
    useMyActiveSprintsMock.mockReturnValue({
      data: [{ project_id: 'p1', project_name: 'Alpha' }],
      isLoading: false,
      error: null,
    });
    renderWithRouter(<SprintsView />);
    expect(screen.queryByRole('tablist', { name: /Sprint scope/i })).not.toBeInTheDocument();
  });

  it('opens the Plan sprint modal when Plan next sprint is clicked', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />);
    // Match the header button (exact label) — the timeline's "+ Plan next sprint" slot
    // has a different accessible name and shouldn't be the trigger under test.
    await userEvent.click(
      screen.getByRole('button', { name: /^Plan next sprint$/i }),
    );
    expect(
      screen.getByRole('dialog', { name: /Plan next sprint/i }),
    ).toBeInTheDocument();
  });

  it('renders the My Teams toggle when user has 2+ active sprints', () => {
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
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
    expect(screen.getByRole('tablist', { name: /Sprint scope/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /My Teams \(2\)/i })).toBeInTheDocument();
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
    useMyActiveSprintsMock.mockReturnValue({ data: [], isLoading: false, error: null });
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: vi.fn(), isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
  });

  it('swaps the sprint header for the My Teams lens when the scope tab is toggled', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
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

    await userEvent.click(screen.getByRole('tab', { name: /My Teams \(2\)/i }));

    // Teams scope replaces the header/body with the cross-project lens.
    expect(
      screen.queryByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^My Teams$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /My Teams/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Each team renders a card linking to that project's sprint.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    // Switching back restores the sprint header.
    await userEvent.click(screen.getByRole('tab', { name: /This project/i }));
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('renders the planning-bridge surface for a PLANNED selection', () => {
    useSprintsMock.mockReturnValue({ sprints: [PLANNED], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: null, planned: [PLANNED], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    // Default selection falls back to the next planned sprint → planning bridge.
    expect(screen.getByRole('heading', { name: /Planning bridge/i })).toBeInTheDocument();
    // No active sprint → the header advertises the empty active slot.
    expect(
      screen.getByRole('heading', { level: 1, name: /No sprint yet/i }),
    ).toBeInTheDocument();
  });

  it('renders the closed-outcome skeleton for a COMPLETED selection via ?sprint=', () => {
    // Active sprint exists, but the deep-link pins the selection to the closed one,
    // proving ?sprint= overrides the active→planned→closed fallback.
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE, CLOSED], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [CLOSED], active: ACTIVE, planned: [], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints?sprint=sp-closed'],
    });
    // outcomeQuery.data is undefined in the mock → the outcome skeleton renders.
    expect(
      screen.getByRole('status', { name: /Loading Sprint outcome/i }),
    ).toBeInTheDocument();
    // The active sprint still owns the header even though a closed one is selected.
    expect(
      screen.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeInTheDocument();
  });

  it('opens the filter popover on the first Filter click and closes it on the second', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    expect(
      screen.queryByRole('dialog', { name: /Filter sprint backlog/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(
      screen.getByRole('dialog', { name: /Filter sprint backlog/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    expect(
      screen.queryByRole('dialog', { name: /Filter sprint backlog/i }),
    ).not.toBeInTheDocument();
  });

  it('closes the active sprint, confirms with a toast + retro handoff, then clears the banner on Run', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const closeMutate = vi.fn(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintsMock.mockReturnValue({
      sprints: [ACTIVE, PLANNED], isLoading: false, error: null,
    });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [PLANNED], isLoading: false, error: null,
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
    const closeMutate = vi.fn(
      (_vars: unknown, opts: { onError?: () => void }) => opts.onError?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
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

  it('surfaces capacity warnings after activating a planned sprint and dismisses them', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const activateMutate = vi.fn(
      (_id: string, opts: { onSuccess?: (data: unknown) => void }) =>
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
      closed: [], active: null, planned: [PLANNED], isLoading: false, error: null,
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
      closed: [], active: null, planned: [readyPlanned], isLoading: false, error: null,
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
    const activateMutate = vi.fn(
      (_id: string, opts: { onError?: (e: unknown) => void }) =>
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
      closed: [], active: null, planned: [readyPlanned], isLoading: false, error: null,
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
      closed: [], active: null, planned: [PLANNED_FAR], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    expect(
      screen.getByRole('dialog', { name: /Edit planned sprint/i }),
    ).toBeInTheDocument();
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
      closed: [], active: pendingSprint, planned: [], isLoading: false, error: null,
    });

    // Denied: pending items exist but the user can't manage scope → no button.
    canManageScopeMock.mockReturnValue(false);
    const { unmount } = renderWithRouter(<SprintsView />, {
      initialEntries: ['/projects/proj-1/sprints'],
    });
    expect(
      screen.queryByRole('button', { name: /Review pending/i }),
    ).not.toBeInTheDocument();
    unmount();

    // Allowed: same pending count, manage-scope granted → the review button shows.
    canManageScopeMock.mockReturnValue(true);
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });
    expect(
      screen.getByRole('button', { name: /Review pending \(2\)/i }),
    ).toBeInTheDocument();
  });

  it('offers a Plan CTA in the empty state only when the user can manage scope', () => {
    useSprintsMock.mockReturnValue({ sprints: [], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: null, planned: [], isLoading: false, error: null,
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
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    // The stored IN_PROGRESS status shows as pressed; a different one does not.
    expect(
      screen.getByRole('button', { name: /In Progress/i, pressed: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Backlog$/i, pressed: false }),
    ).toBeInTheDocument();

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
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
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
      closed: [], active: null, planned: [PLANNED], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    fireEvent.keyDown(document, { key: 'c' });
    expect(screen.getByRole('dialog', { name: /Add task/i })).toHaveTextContent(
      'target:sp-planned',
    );
  });

  it('truncates the capacity-warning list to three with an overflow note, then dismisses', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const activateMutate = vi.fn(
      (_id: string, opts: { onSuccess?: (data: unknown) => void }) =>
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
      closed: [], active: null, planned: [readyPlanned], isLoading: false, error: null,
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
    const closeMutate = vi.fn(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    useSprintMutationsMock.mockReturnValue({
      closeSprint: { mutate: closeMutate, isPending: false },
      createSprint: { mutate: vi.fn() },
      activateSprint: { mutate: vi.fn() },
      updateSprint: { mutate: vi.fn(), isPending: false },
    });
    useSprintsMock.mockReturnValue({ sprints: [ACTIVE], isLoading: false, error: null });
    useSprintsByStateMock.mockReturnValue({
      closed: [], active: ACTIVE, planned: [], isLoading: false, error: null,
    });
    renderWithRouter(<SprintsView />, { initialEntries: ['/projects/proj-1/sprints'] });

    await userEvent.click(screen.getByRole('button', { name: /Close active sprint/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Close sprint$/i }));
    expect(
      screen.getByRole('button', { name: /Dismiss retro handoff/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Dismiss retro handoff/i }));
    expect(
      screen.queryByRole('button', { name: /Dismiss retro handoff/i }),
    ).not.toBeInTheDocument();
  });
});
