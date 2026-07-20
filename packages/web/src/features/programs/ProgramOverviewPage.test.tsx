import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramOverviewPage, kpiDrillTarget } from './ProgramOverviewPage';

// Hoisted so the vi.mock factory can reference it without a value-level
// reference to apiClient.get (which the unbound-method lint rule rejects).
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: mockGet } }));

interface RollupShape {
  aggregation_policy: string;
  policy_available: boolean;
  project_count: number;
  program_health: string;
  kpis: Record<string, unknown>;
}

function rollup(overrides: Partial<RollupShape> = {}): RollupShape {
  return {
    aggregation_policy: 'worst',
    policy_available: true,
    project_count: 3,
    program_health: 'at_risk',
    kpis: {},
    ...overrides,
  };
}

// The page now fetches two endpoints: the rollup (GET …/rollup/) and the
// program detail for the identity header (GET …/programs/:id/, #963). Route the
// mocked apiClient.get by URL so both resolve. `rollupData` may be an Error to
// exercise the rollup failure path while the header still renders.
function mockApi(rollupData: RollupShape | Error, program: Record<string, unknown> = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/rollup')) {
      return rollupData instanceof Error
        ? Promise.reject(rollupData)
        : Promise.resolve({ data: rollupData });
    }
    return Promise.resolve({
      data: { id: 'p-1', name: 'Program One', code: '', color: null, ...program },
    });
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/overview']}>
        <Routes>
          <Route path="/programs/:programId/overview" element={<ProgramOverviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramOverviewPage (#713)', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('renders the identity header with the program name and code (#963)', async () => {
    mockApi(rollup(), { name: 'Phoenix Rollout', code: 'PHX', color: '#7C3AED' });
    renderPage();
    // The NAME is the heading — the accent square is decorative (aria-hidden).
    expect(await screen.findByRole('heading', { name: 'Phoenix Rollout' })).toBeInTheDocument();
    // Code appears in the chip (and again as the decorative square label).
    expect(screen.getAllByText('PHX').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the health hero with band and policy subtitle', async () => {
    mockApi(rollup({ program_health: 'critical' }));
    renderPage();
    expect(await screen.findByLabelText('Program health: Critical')).toBeInTheDocument();
    expect(screen.getByText('Worst-case across 3 projects')).toBeInTheDocument();
  });

  it('renders enabled KPI values (count, health band, variance)', async () => {
    mockApi(
      rollup({
        kpis: {
          schedule_health: { available: true, value: 'on_track' },
          critical_tasks: { available: true, value: 12 },
          baseline_variance: { available: true, value: 9, unit: 'calendar_days' },
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('On track')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('+9d')).toBeInTheDocument();
  });

  it('shows a deferred KPI muted with its reason rather than hiding it', async () => {
    mockApi(rollup({ kpis: { cost_variance: { available: false, reason: 'no_cost_data' } } }));
    renderPage();
    expect(await screen.findByText('Cost variance')).toBeInTheDocument();
    expect(screen.getByText('Needs cost data')).toBeInTheDocument();
  });

  it('renders a null variance as an em dash', async () => {
    mockApi(
      rollup({
        kpis: { schedule_variance: { available: true, value: null, unit: 'calendar_days' } },
      }),
    );
    renderPage();
    expect(await screen.findByText('Schedule variance')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the empty state for a program with no projects', async () => {
    mockApi(rollup({ project_count: 0, program_health: 'unknown' }));
    renderPage();
    expect(await screen.findByText('No projects in this program yet.')).toBeInTheDocument();
  });

  it('notes the budget-weighting fallback when policy is unavailable', async () => {
    mockApi(rollup({ aggregation_policy: 'weighted_by_budget', policy_available: false }));
    renderPage();
    expect(
      await screen.findByText('Budget weighting is unavailable — showing the average instead.'),
    ).toBeInTheDocument();
  });

  it('renders an error state when the rollup request fails', async () => {
    mockApi(new Error('boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load the program rollup.',
    );
  });

  // --- KPI drill-through (#2155) -------------------------------------------

  it('makes actionable task-count and health KPI cards drill into the projects list', async () => {
    mockApi(
      rollup({
        kpis: {
          critical_tasks: { available: true, value: 5 },
          at_risk_tasks: { available: true, value: 3 },
          schedule_health: { available: true, value: 'at_risk' },
        },
      }),
    );
    renderPage();
    // at_risk_tasks maps 1:1 to the per-project annotation, so it sorts the list.
    expect(
      await screen.findByRole('link', { name: /At-risk tasks: 3\. View at-risk projects\./ }),
    ).toHaveAttribute('href', '/programs/p-1/projects?sort=at-risk');
    // critical_tasks has no per-project annotation, but critical ⊂ at-risk, so it
    // reuses the at-risk sort to surface contributing projects first.
    expect(
      screen.getByRole('link', { name: /Critical tasks: 5\. View contributing projects\./ }),
    ).toHaveAttribute('href', '/programs/p-1/projects?sort=at-risk');
    // A non-benign health band drills to the projects.
    expect(
      screen.getByRole('link', { name: /Schedule health: At risk\. View the projects\./ }),
    ).toHaveAttribute('href', '/programs/p-1/projects');
  });

  it('keeps real-zero and benign-health KPI cards static (rule 172)', async () => {
    mockApi(
      rollup({
        program_health: 'on_track',
        kpis: {
          critical_tasks: { available: true, value: 0 },
          schedule_health: { available: true, value: 'on_track' },
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('Critical tasks')).toBeInTheDocument();
    // No zero-count or on-track card becomes a dead-end link.
    expect(screen.queryByRole('link', { name: /Critical tasks/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Schedule health/ })).not.toBeInTheDocument();
  });
});

describe('kpiDrillTarget (#2155)', () => {
  it('links at-risk tasks to the sorted list only when the count is positive', () => {
    expect(kpiDrillTarget('at_risk_tasks', { available: true, value: 4 }, 'pg')).toEqual({
      to: '/programs/pg/projects?sort=at-risk',
      toLabel: 'at-risk projects',
    });
    expect(kpiDrillTarget('at_risk_tasks', { available: true, value: 0 }, 'pg')).toBeUndefined();
  });

  it('links critical tasks to the at-risk-sorted list (critical ⊂ at-risk)', () => {
    expect(kpiDrillTarget('critical_tasks', { available: true, value: 2 }, 'pg')).toEqual({
      to: '/programs/pg/projects?sort=at-risk',
      toLabel: 'contributing projects',
    });
  });

  it('drills a health band only when it is at-risk or critical', () => {
    expect(kpiDrillTarget('schedule_health', { available: true, value: 'critical' }, 'pg')).toEqual(
      { to: '/programs/pg/projects', toLabel: 'the projects' },
    );
    expect(
      kpiDrillTarget('schedule_health', { available: true, value: 'on_track' }, 'pg'),
    ).toBeUndefined();
  });

  it('never drills a deferred KPI or an unrelated metric', () => {
    expect(kpiDrillTarget('critical_tasks', { available: false, reason: 'no_cost_data' }, 'pg')).toBeUndefined();
    expect(kpiDrillTarget('baseline_variance', { available: true, value: 9 }, 'pg')).toBeUndefined();
  });
});
