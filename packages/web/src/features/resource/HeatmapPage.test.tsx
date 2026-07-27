/**
 * HeatmapPage unit tests.
 *
 * Two concerns live here:
 *  - the `resources_heatmap.level_loads` extension slot. Adoption-first (issue
 *    1614): when no Enterprise override is registered — the state of every OSS
 *    install — the slot must render nothing. A permanently disabled "Level
 *    loads" teaser button is forbidden. When Enterprise registers an override,
 *    its component renders in place.
 *  - the page's own branching (#2459 coverage backfill): the KPI and heatmap
 *    sections each fan out over loading / success / empty / error, the header
 *    derives the over-allocated pill and week label from whichever data has
 *    landed, and either query returning 409 collapses the whole body into the
 *    "run the scheduler" empty state.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeatmapPage } from './HeatmapPage';
import { registry } from '@/lib/widget-registry';
import { renderWithProviders } from '@/test/utils';
import type {
  HeatmapResource,
  UseResourceHeatmapResult,
} from '@/hooks/useResourceHeatmap';
import type {
  ResourceSummary,
  UseResourceSummaryResult,
} from '@/hooks/useResourceSummary';

const { heatmapMock, summaryMock, triggerMock, projectIdMock } = vi.hoisted(() => ({
  heatmapMock:
    vi.fn<
      (
        projectId: string | undefined,
        start: string,
        weeks: number,
        groupBy: string,
      ) => UseResourceHeatmapResult
    >(),
  summaryMock: vi.fn<(projectId: string | undefined) => UseResourceSummaryResult>(),
  triggerMock: vi.fn<() => Promise<void>>(),
  projectIdMock: vi.fn<() => string | undefined>(),
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectIdMock() }));
vi.mock('@/hooks/useTriggerScheduler', () => ({ useTriggerScheduler: () => triggerMock }));
vi.mock('@/hooks/useResourceHeatmap', () => ({
  useResourceHeatmap: (
    projectId: string | undefined,
    start: string,
    weeks: number,
    groupBy: string,
  ) => heatmapMock(projectId, start, weeks, groupBy),
}));
vi.mock('@/hooks/useResourceSummary', () => ({
  useResourceSummary: (projectId: string | undefined) => summaryMock(projectId),
}));

const SLOT = 'resources_heatmap.level_loads';

// --- fixtures ---------------------------------------------------------------

const loadingHeatmap: UseResourceHeatmapResult = {
  data: undefined,
  status: 'loading',
  error: null,
};
const loadingSummary: UseResourceSummaryResult = {
  data: undefined,
  status: 'loading',
  error: null,
};

function person(overrides: Partial<HeatmapResource> = {}): HeatmapResource {
  return {
    id: 'r1',
    name: 'Alice Adams',
    initials: 'AA',
    job_role: 'Engineer',
    color: '#336699',
    calendar_differs_from_project: false,
    util: [80, 120],
    ...overrides,
  };
}

function summary(overrides: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    avg_utilization_pct: 75,
    over_allocated_count: 0,
    over_allocated_weeks: '',
    under_utilized_count: 0,
    under_utilized_names: [],
    headcount: 4,
    contractor_count: 0,
    ...overrides,
  };
}

function heatmapSuccess(
  resources: HeatmapResource[],
  weeks: string[] = ['2026-W18', '2026-W19'],
): UseResourceHeatmapResult {
  return { data: { weeks, resources }, status: 'success', error: null };
}

/**
 * Replace `window.location` with a clone whose `reload` is a spy. jsdom marks
 * `Location.reload` non-configurable, so the property itself cannot be spied —
 * only the whole `location` binding can be swapped.
 */
function stubReload() {
  const original = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, reload },
  });
  return {
    reload,
    restore: () =>
      Object.defineProperty(window, 'location', { configurable: true, value: original }),
  };
}

/** Last argument tuple the heatmap hook was called with (the page's live state). */
function lastHeatmapArgs() {
  const calls = heatmapMock.mock.calls;
  return calls[calls.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  projectIdMock.mockReturnValue('project-1');
  triggerMock.mockResolvedValue(undefined);
  heatmapMock.mockReturnValue(loadingHeatmap);
  summaryMock.mockReturnValue(loadingSummary);
});

afterEach(() => {
  // The registry is a shared singleton; drop any override registered by a test.
  registry.get(SLOT).length = 0;
});

// ---------------------------------------------------------------------------

describe('HeatmapPage — level_loads extension slot', () => {
  it('renders no "Level loads" control when the slot has no override (OSS)', () => {
    renderWithProviders(<HeatmapPage />);
    expect(screen.queryByRole('button', { name: /Level loads/i })).not.toBeInTheDocument();
  });

  it('renders the Enterprise component when an override is registered', () => {
    registry.register(SLOT, {
      id: 'enterprise-level-loads',
      priority: 0,
      component: () => <button type="button">⚡ Level loads</button>,
    });
    renderWithProviders(<HeatmapPage />);
    expect(screen.getByRole('button', { name: /Level loads/i })).toBeInTheDocument();
  });
});

describe('HeatmapPage — KPI section', () => {
  it('shows the KPI skeleton, not KPI values, while the summary is loading', () => {
    renderWithProviders(<HeatmapPage />);
    expect(screen.queryByText('Avg utilization')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load summary/)).not.toBeInTheDocument();
  });

  it('renders the four KPI cards once the summary resolves', () => {
    summaryMock.mockReturnValue({
      data: summary({ avg_utilization_pct: 82, headcount: 6 }),
      status: 'success',
      error: null,
    });
    renderWithProviders(<HeatmapPage />);

    expect(screen.getByText('Avg utilization')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('6 active')).toBeInTheDocument();
  });

  it('offers a retry line instead of the cards when the summary errors', () => {
    summaryMock.mockReturnValue({
      data: undefined,
      status: 'error',
      error: new Error('500'),
    });
    renderWithProviders(<HeatmapPage />);

    expect(screen.getByText(/Could not load summary/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Avg utilization')).not.toBeInTheDocument();
  });

  it('reloads the page when the summary retry link is used', async () => {
    const stub = stubReload();
    summaryMock.mockReturnValue({ data: undefined, status: 'error', error: new Error('500') });
    renderWithProviders(<HeatmapPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(stub.reload).toHaveBeenCalled();
    stub.restore();
  });
});

describe('HeatmapPage — heatmap section', () => {
  it('renders neither the grid nor an error while the heatmap is loading', () => {
    renderWithProviders(<HeatmapPage />);
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load heatmap/)).not.toBeInTheDocument();
  });

  it('renders the utilization grid when resources are returned', () => {
    heatmapMock.mockReturnValue(heatmapSuccess([person()]));
    renderWithProviders(<HeatmapPage />);

    const grid = screen.getByRole('grid', { name: 'Resource utilization heatmap' });
    expect(within(grid).getByText('Alice Adams')).toBeInTheDocument();
    expect(
      within(grid).getByRole('button', { name: 'Alice Adams, W19, 120% utilized' }),
    ).toBeInTheDocument();
  });

  it('prompts the user toward the Roster tab when the team is empty', () => {
    heatmapMock.mockReturnValue(heatmapSuccess([]));
    renderWithProviders(<HeatmapPage />);

    const empty = screen.getByRole('status');
    expect(empty).toHaveTextContent('No team members yet');
    expect(
      within(empty).getByRole('link', { name: 'add resources via the Roster tab' }),
    ).toHaveAttribute('href', '../roster');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('offers a retry line instead of the grid when the heatmap errors', () => {
    heatmapMock.mockReturnValue({ data: undefined, status: 'error', error: new Error('500') });
    renderWithProviders(<HeatmapPage />);

    expect(screen.getByText(/Could not load heatmap/)).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('reloads the page when the heatmap retry link is used', async () => {
    const stub = stubReload();
    heatmapMock.mockReturnValue({ data: undefined, status: 'error', error: new Error('500') });
    renderWithProviders(<HeatmapPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(stub.reload).toHaveBeenCalled();
    stub.restore();
  });

  it('renders nothing in the heatmap slot when the query is idle (no project)', () => {
    projectIdMock.mockReturnValue(undefined);
    heatmapMock.mockReturnValue({ data: undefined, status: 'idle', error: null });
    summaryMock.mockReturnValue({ data: undefined, status: 'idle', error: null });
    renderWithProviders(<HeatmapPage />);

    // Header still renders, body is empty of grid / empty-state / error.
    expect(screen.getByRole('heading', { name: 'Resource allocation' })).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load heatmap/)).not.toBeInTheDocument();
  });

  it('renders nothing when the query reports success but carries no payload', () => {
    heatmapMock.mockReturnValue({ data: undefined, status: 'success', error: null });
    renderWithProviders(<HeatmapPage />);

    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('HeatmapPage — header derived state', () => {
  it('hides the over-allocated pill when nobody is over-allocated', () => {
    summaryMock.mockReturnValue({
      data: summary({ over_allocated_count: 0 }),
      status: 'success',
      error: null,
    });
    renderWithProviders(<HeatmapPage />);
    expect(screen.queryByText(/over-allocated$/)).not.toBeInTheDocument();
  });

  it('shows the over-allocated pill with the count from the summary', () => {
    summaryMock.mockReturnValue({
      data: summary({ over_allocated_count: 3 }),
      status: 'success',
      error: null,
    });
    renderWithProviders(<HeatmapPage />);
    expect(screen.getByText('3 over-allocated')).toBeInTheDocument();
  });

  it('treats a still-loading summary as zero over-allocated', () => {
    renderWithProviders(<HeatmapPage />);
    expect(screen.queryByText(/over-allocated/)).not.toBeInTheDocument();
  });

  it('labels the week nav from the first week the heatmap returned', () => {
    // Empty roster keeps the grid (whose column headers repeat the labels) out
    // of the DOM, so the assertion targets the header nav unambiguously.
    heatmapMock.mockReturnValue(heatmapSuccess([], ['2026-W23', '2026-W24']));
    renderWithProviders(<HeatmapPage />);
    expect(screen.getByText('W23')).toBeInTheDocument();
  });

  it('falls back to a placeholder week label before any data has landed', () => {
    renderWithProviders(<HeatmapPage />);
    expect(screen.getByText('W01')).toBeInTheDocument();
  });

  it('shows a non-ISO week label verbatim rather than mangling it', () => {
    heatmapMock.mockReturnValue(heatmapSuccess([], ['week-one', 'week-two']));
    renderWithProviders(<HeatmapPage />);
    expect(screen.getByText('week-one')).toBeInTheDocument();
  });
});

describe('HeatmapPage — controls', () => {
  it('moves the requested window back one week', async () => {
    renderWithProviders(<HeatmapPage />);
    const before = lastHeatmapArgs()[1];

    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));

    const after = lastHeatmapArgs()[1];
    expect(Date.parse(after)).toBe(Date.parse(before) - 7 * 86400_000);
  });

  it('moves the requested window forward one week', async () => {
    renderWithProviders(<HeatmapPage />);
    const before = lastHeatmapArgs()[1];

    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));

    const after = lastHeatmapArgs()[1];
    expect(Date.parse(after)).toBe(Date.parse(before) + 7 * 86400_000);
  });

  it('cycles the group-by toggle none → role → none', async () => {
    renderWithProviders(<HeatmapPage />);
    expect(lastHeatmapArgs()[3]).toBe('none');
    expect(screen.getByRole('button', { name: 'Group by: None' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Group by: None' }));
    expect(lastHeatmapArgs()[3]).toBe('role');
    expect(screen.getByRole('button', { name: 'Group by: Role' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Group by: Role' }));
    expect(lastHeatmapArgs()[3]).toBe('none');
    expect(screen.getByRole('button', { name: 'Group by: None' })).toBeInTheDocument();
  });

  it('requests the selected week window and remembers it', async () => {
    renderWithProviders(<HeatmapPage />);
    expect(lastHeatmapArgs()[2]).toBe(8);

    const group = screen.getByRole('group', { name: 'Week window' });
    await userEvent.click(within(group).getByRole('button', { name: '16w' }));

    expect(lastHeatmapArgs()[2]).toBe(16);
    expect(within(group).getByRole('button', { name: '16w' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(localStorage.getItem('trueppm.heatmap.window.v1')).toBe('16');
  });

  it('starts from the persisted week window on a fresh mount', () => {
    localStorage.setItem('trueppm.heatmap.window.v1', '12');
    renderWithProviders(<HeatmapPage />);
    expect(lastHeatmapArgs()[2]).toBe(12);
  });
});

describe('HeatmapPage — schedule-not-run empty state', () => {
  it('replaces the whole body when the heatmap reports 409', () => {
    heatmapMock.mockReturnValue({ data: undefined, status: 'schedule-not-run', error: null });
    summaryMock.mockReturnValue({
      data: summary(),
      status: 'success',
      error: null,
    });
    renderWithProviders(<HeatmapPage />);

    expect(screen.getByText('Schedule not yet computed')).toBeInTheDocument();
    expect(screen.queryByText('Avg utilization')).not.toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('also triggers on a 409 from the summary alone', () => {
    heatmapMock.mockReturnValue(heatmapSuccess([person()]));
    summaryMock.mockReturnValue({ data: undefined, status: 'schedule-not-run', error: null });
    renderWithProviders(<HeatmapPage />);

    expect(screen.getByText('Schedule not yet computed')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('runs the scheduler from the empty-state CTA', async () => {
    heatmapMock.mockReturnValue({ data: undefined, status: 'schedule-not-run', error: null });
    renderWithProviders(<HeatmapPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Run Scheduler' }));

    expect(triggerMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the header controls usable while the empty state is shown', () => {
    heatmapMock.mockReturnValue({ data: undefined, status: 'schedule-not-run', error: null });
    renderWithProviders(<HeatmapPage />);

    expect(screen.getByRole('button', { name: 'Next week' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Week window' })).toBeInTheDocument();
  });
});
