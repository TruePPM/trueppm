import { screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { SprintsView } from './SprintsView';
import { makeSprint } from './sprintTestFixtures';

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
}));

const useMyActiveSprintsMock = vi.fn(() => ({
  data: [] as Array<{ project_id: string; project_name: string }>,
  isLoading: false,
  error: null,
}));

vi.mock('@/hooks/useMyActiveSprints', () => ({
  useMyActiveSprints: () => useMyActiveSprintsMock(),
}));

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
    expect(screen.getByText(/Loading sprints/i)).toBeInTheDocument();
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
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load sprints/i);
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
