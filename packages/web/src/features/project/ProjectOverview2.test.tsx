import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloResult } from '@/types';
import { ProjectOverview2, commitmentChip, type Overview2Data } from './ProjectOverview2';

const h = vi.hoisted(() => ({
  mc: { data: undefined, isLoading: false, error: null } as {
    data: Partial<MonteCarloResult> | undefined;
    isLoading: boolean;
    error: Error | null;
  },
  overview: undefined as unknown,
}));

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => ({ ...h.mc, refetch: vi.fn() }),
}));
vi.mock('@/api/client', () => ({
  apiClient: { get: () => Promise.resolve({ data: h.overview }) },
}));

const OVERVIEW: Overview2Data = {
  critical_task_count: 4,
  total_tasks: 12,
  complete_tasks: 3,
  open_risk_count: 5,
  high_risk_count: 2,
  next_milestone: { id: 'm1', name: 'Beta', date: '2026-12-01', percent_complete: 40 },
  definitions: { open_risk_count: 'Server risk sentence.' },
};

const MC: Partial<MonteCarloResult> = {
  p50: '2026-12-01',
  p80: '2026-12-07',
  p95: '2026-12-15',
  nSimulations: 5000,
  runs: 5000,
  lastRunAt: '2026-11-20T09:12:00Z',
  commitmentDate: '2026-12-05',
  p80DeltaVsCommitmentDays: 2,
  cpmFinish: '2026-11-28',
  confidenceCurve: [],
  definitions: { p80: 'Server P80 sentence.' },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectOverview2 projectId="p1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('commitmentChip', () => {
  it('words and signs the server delta, and is absent when the server has none', () => {
    expect(commitmentChip(2)).toEqual({ tone: 'risk', label: '+2d past commitment' });
    expect(commitmentChip(-3)).toEqual({ tone: 'ok', label: '3d ahead of commitment' });
    expect(commitmentChip(0)?.label).toBe('on commitment');
    expect(commitmentChip(null)).toBeNull();
  });
});

describe('ProjectOverview2', () => {
  beforeEach(() => {
    h.mc = { data: MC, isLoading: false, error: null };
    h.overview = OVERVIEW;
  });

  it('renders one lead figure with the server definition and a spoken label', async () => {
    renderPage();
    const fig = await screen.findByTestId('overview2-lead-figure');
    expect(fig.querySelector('.sr-only')?.textContent).toMatch(
      /^Forecast finish P80, .*December.*7.*, as of /,
    );
    expect(screen.getAllByTestId('overview2-lead-figure')).toHaveLength(1);
    expect(screen.getByTestId('overview2-commitment-chip')).toHaveTextContent(
      '+2d past commitment',
    );
    expect(screen.getByTestId('overview2-lead-footer')).toHaveTextContent('5,000 runs');
    await userEvent.setup().hover(screen.getByRole('button', { name: 'Forecast finish · P80' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Server P80 sentence.');
  });

  it('wires the server definition into a tile and leaves unserved ones plain', async () => {
    renderPage();
    await screen.findByTestId('overview2-tiles');
    expect(screen.getByRole('button', { name: 'Open risks' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Critical tasks' })).not.toBeInTheDocument();
    expect(screen.getByText('Critical tasks')).toBeInTheDocument();
  });

  it('states cost variance as one not-computable line, not a tile', async () => {
    renderPage();
    const line = await screen.findByTestId('not-computable');
    expect(line).toHaveTextContent('Cost variance');
    expect(
      screen.getAllByTestId('overview2-tile').every((t) => !t.textContent?.includes('Cost')),
    ).toBe(true);
  });

  it('omits the risks tile when the server did not serve a count', async () => {
    h.overview = { ...OVERVIEW, open_risk_count: undefined };
    renderPage();
    await screen.findByTestId('overview2-tiles');
    expect(screen.queryByText('Open risks')).not.toBeInTheDocument();
  });

  it('shows the empty state when there is no forecast', async () => {
    h.mc = { data: undefined, isLoading: false, error: null };
    renderPage();
    expect(await screen.findByTestId('overview2-empty')).toHaveTextContent('No forecast yet');
  });

  it('shows the forecast error line and keeps the tiles', async () => {
    h.mc = { data: undefined, isLoading: false, error: new Error('x') };
    renderPage();
    expect(await screen.findByText(/Forecast didn’t finish/)).toBeInTheDocument();
    expect(await screen.findByTestId('overview2-tiles')).toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    h.mc = { data: undefined, isLoading: true, error: null };
    renderPage();
    expect(screen.getByTestId('overview2-skeleton')).toBeInTheDocument();
  });
});
