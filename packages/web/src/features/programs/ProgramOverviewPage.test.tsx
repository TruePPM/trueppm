import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramOverviewPage } from './ProgramOverviewPage';

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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/overview']}>
        <Routes>
          <Route path="/programs/:programId/overview" element={<ProgramOverviewPage />} />
        </Routes>
      </MemoryRouter>,
    </QueryClientProvider>,
  );
}

describe('ProgramOverviewPage (#713)', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('renders the health hero with band and policy subtitle', async () => {
    mockGet.mockResolvedValue({ data: rollup({ program_health: 'critical' }) });
    renderPage();
    expect(await screen.findByLabelText('Program health: Critical')).toBeInTheDocument();
    expect(screen.getByText('Worst-case across 3 projects')).toBeInTheDocument();
  });

  it('renders enabled KPI values (count, health band, variance)', async () => {
    mockGet.mockResolvedValue({
      data: rollup({
        kpis: {
          schedule_health: { available: true, value: 'on_track' },
          critical_tasks: { available: true, value: 12 },
          baseline_variance: { available: true, value: 9, unit: 'calendar_days' },
        },
      }),
    });
    renderPage();
    expect(await screen.findByText('On track')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('+9d')).toBeInTheDocument();
  });

  it('shows a deferred KPI muted with its reason rather than hiding it', async () => {
    mockGet.mockResolvedValue({
      data: rollup({
        kpis: { cost_variance: { available: false, reason: 'no_cost_data' } },
      }),
    });
    renderPage();
    expect(await screen.findByText('Cost variance')).toBeInTheDocument();
    expect(screen.getByText('Needs cost data')).toBeInTheDocument();
  });

  it('renders a null variance as an em dash', async () => {
    mockGet.mockResolvedValue({
      data: rollup({
        kpis: { schedule_variance: { available: true, value: null, unit: 'calendar_days' } },
      }),
    });
    renderPage();
    expect(await screen.findByText('Schedule variance')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the empty state for a program with no projects', async () => {
    mockGet.mockResolvedValue({
      data: rollup({ project_count: 0, program_health: 'unknown' }),
    });
    renderPage();
    expect(await screen.findByText('No projects in this program yet.')).toBeInTheDocument();
  });

  it('notes the budget-weighting fallback when policy is unavailable', async () => {
    mockGet.mockResolvedValue({
      data: rollup({ aggregation_policy: 'weighted_by_budget', policy_available: false }),
    });
    renderPage();
    expect(
      await screen.findByText('Budget weighting is unavailable — showing the average instead.'),
    ).toBeInTheDocument();
  });

  it('renders an error state when the rollup request fails', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load the program rollup.');
  });
});
