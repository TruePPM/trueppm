import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentForecastImpact } from './AgentForecastImpact';

const mockGet = vi.fn();
vi.mock('@/api/client', () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) as Promise<unknown> },
}));

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('AgentForecastImpact', () => {
  beforeEach(() => mockGet.mockReset());

  it('renders the P80 completion from the program rollup + the honest N=0 contribution strip', async () => {
    mockGet.mockResolvedValue({
      data: {
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 3,
        program_health: 'at_risk',
        kpis: {
          p80_completion: {
            available: true,
            unit: 'date',
            value: '2027-11-02',
            projects_without_forecast: 1,
          },
        },
      },
    });
    renderWithClient(<AgentForecastImpact programId="prog-1" onViewActivity={() => {}} />);
    expect(await screen.findByText(/November 2, 2027/)).toBeInTheDocument();
    expect(screen.queryByText('2027-11-02')).not.toBeInTheDocument();
    expect(screen.getByText('excludes 1 project without a forecast')).toBeInTheDocument();
    expect(screen.getByText(/No agent-completed work yet/i)).toBeInTheDocument();
  });

  it('shows the run-a-forecast empty state when no Monte Carlo run exists', async () => {
    mockGet.mockResolvedValue({
      data: {
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 1,
        program_health: 'unknown',
        kpis: { p80_completion: { available: false, reason: 'no_montecarlo_store' } },
      },
    });
    renderWithClient(<AgentForecastImpact programId="prog-1" onViewActivity={() => {}} />);
    expect(await screen.findByText(/No saved Monte Carlo run/i)).toBeInTheDocument();
  });

  it('explains why there is no date when the server computed none (#4779)', async () => {
    mockGet.mockResolvedValue({
      data: {
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 2,
        program_health: 'unknown',
        kpis: {
          p80_completion: {
            available: true,
            unit: 'date',
            value: null,
            reason: 'no_forecast',
            projects_without_forecast: 2,
          },
        },
      },
    });
    renderWithClient(<AgentForecastImpact programId="prog-1" onViewActivity={() => {}} />);
    expect(await screen.findByText('No project has a forecast yet')).toBeInTheDocument();
  });
});
