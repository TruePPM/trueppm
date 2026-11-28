import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloResult } from '@/types';
import {
  ProjectOverview2,
  commitmentChip,
  leadSpokenLabel,
  liveSnapshotRows,
  stalenessCaveat,
  type Overview2Data,
} from './ProjectOverview2';

const h = vi.hoisted(() => ({
  mc: { data: undefined, isLoading: false, error: null } as {
    data: Partial<MonteCarloResult> | undefined;
    isLoading: boolean;
    error: Error | null;
  },
  overview: undefined as unknown,
  history: undefined as unknown,
  tasks: [{ id: 't9', name: 'Pour foundation' }] as { id: string; name: string }[],
  taskOpts: [] as unknown[],
  bp: 'lg' as 'sm' | 'md' | 'lg',
  changelog: { results: [], next_cursor: null } as unknown,
  chain: undefined as unknown,
}));

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => ({ ...h.mc, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useMonteCarloHistory', () => ({
  useMonteCarloHistory: () => ({ data: h.history }),
}));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: (_id: string, opts: unknown) => {
    h.taskOpts.push(opts);
    return { tasks: h.tasks };
  },
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => h.bp }));
vi.mock('@/api/client', () => ({
  apiClient: {
    get: (url: string) =>
      Promise.resolve({
        data: url.includes('/changelog/')
          ? h.changelog
          : url.includes('/driving-chain/')
            ? h.chain
            : h.overview,
      }),
  },
}));

const OVERVIEW: Overview2Data = {
  critical_task_count: 4,
  total_tasks: 12,
  complete_tasks: 3,
  open_risk_count: 5,
  high_risk_count: 2,
  next_milestone: { id: 'm1', name: 'Beta', date: '2026-12-01', percent_complete: 40 },
  as_of: '2026-11-20T09:12:00Z',
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
  forecastStaleness: 'current',
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
    h.history = undefined;
    h.tasks = [{ id: 't9', name: 'Pour foundation' }];
    h.taskOpts = [];
    h.bp = 'lg';
  });

  it('renders one lead figure with the server definition and a spoken label', async () => {
    renderPage();
    const fig = await screen.findByTestId('overview2-lead-figure');
    expect(fig.querySelector('.sr-only')?.textContent).toMatch(
      /^Forecast finish P80, .*December.*7.*, as of /,
    );
    expect(screen.getAllByTestId('overview2-lead-figure')).toHaveLength(1);
    expect(fig.className).toContain('text-[44px]');
    await screen.findByTestId('overview2-tiles');
    for (const t of screen.getAllByTestId('overview2-tile')) {
      expect(t.innerHTML).not.toContain('text-[44px]');
      expect(t.innerHTML).toContain('text-[20px]');
    }
    expect(screen.queryByTestId('overview2-staleness')).not.toBeInTheDocument();
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

  it.each([
    ['aged', 'Stale — rerun for updated forecast'],
    ['projectChanged', 'Edited since this run'],
  ] as const)('caveats the lead figure with a word and glyph when %s', async (state, text) => {
    h.mc = { data: { ...MC, forecastStaleness: state }, isLoading: false, error: null };
    renderPage();
    expect(await screen.findByTestId('overview2-staleness')).toHaveTextContent(`◆ ${text}`);
  });

  it('makes no staleness claim for unknown, and flags a velocity-clamped lower bound', () => {
    expect(stalenessCaveat({ forecastStaleness: 'unknown' })).toEqual([]);
    expect(
      stalenessCaveat({ forecastStaleness: 'current', velocitySaturatedRuns: 3 }),
    ).toHaveLength(1);
  });

  it('names the top sensitivity driver from the task list in the Why link', async () => {
    h.mc = {
      data: { ...MC, sensitivity: [{ taskId: 't9', index: 0.8 }] },
      isLoading: false,
      error: null,
    };
    renderPage();
    expect(await screen.findByTestId('overview2-driver')).toHaveTextContent('Pour foundation');
  });

  it('says where the P80 moved from only when the prior run differs', async () => {
    h.history = [
      { takenAt: '2026-11-20T09:12:00Z', p80: '2026-12-07' },
      { takenAt: '2026-11-13T09:12:00Z', p80: '2026-12-01' },
    ];
    renderPage();
    expect(await screen.findByTestId('overview2-moved')).toHaveTextContent(
      /moved from .*Dec.* 1.* on .*Nov/,
    );
  });

  it('omits the moved line when the prior P80 is the same', async () => {
    h.history = [
      { takenAt: '2026-11-20T09:12:00Z', p80: '2026-12-07' },
      { takenAt: '2026-11-13T09:12:00Z', p80: '2026-12-07' },
    ];
    renderPage();
    await screen.findByTestId('overview2-lead-footer');
    expect(screen.queryByTestId('overview2-moved')).not.toBeInTheDocument();
  });
});

describe('#5104 / #5103 additions', () => {
  it("the lead figure's spoken label carries the staleness caveat", () => {
    expect(leadSpokenLabel('December 7, 2026', '9:12 AM', [])).toBe(
      'Forecast finish P80, December 7, 2026, as of 9:12 AM',
    );
    expect(leadSpokenLabel('December 7, 2026', null, ['Edited since this run'])).toBe(
      'Forecast finish P80, December 7, 2026. Edited since this run',
    );
  });

  it("the composer's live rows say why a figure is missing rather than inventing one", () => {
    const rows = liveSnapshotRows(undefined);
    expect(rows.map((r) => r.value)).toEqual([null, null, null]);
    expect(rows[0].notComputable).toBe('no forecast has run');
  });
});

describe('#5104 driver lookup and phone layout', () => {
  beforeEach(() => {
    h.mc = { data: MC, isLoading: false, error: null };
    h.overview = OVERVIEW;
    h.history = undefined;
    h.tasks = [{ id: 't9', name: 'Pour foundation' }];
    h.taskOpts = [];
    h.bp = 'lg';
  });

  it('does not enable the task lookup when there is no sensitivity driver', async () => {
    renderPage();
    await screen.findByTestId('overview2-lead');
    expect(h.taskOpts.length).toBeGreaterThan(0);
    expect(h.taskOpts.every((o) => (o as { enabled: boolean }).enabled === false)).toBe(true);
    expect(screen.queryByTestId('overview2-driver')).not.toBeInTheDocument();
  });

  it('enables the task lookup only once a top driver exists', async () => {
    h.mc = {
      data: { ...MC, sensitivity: [{ taskId: 't9', index: 0.8 }] },
      isLoading: false,
      error: null,
    };
    renderPage();
    await screen.findByTestId('overview2-lead');
    expect(h.taskOpts.every((o) => (o as { enabled: boolean }).enabled === true)).toBe(true);
  });

  it('omits the driver line when the top driver is not in the task list', async () => {
    h.tasks = [{ id: 'other', name: 'Elsewhere' }];
    h.mc = {
      data: { ...MC, sensitivity: [{ taskId: 't9', index: 0.8 }] },
      isLoading: false,
      error: null,
    };
    renderPage();
    const link = await screen.findByRole('link', { name: /Why this date\?/ });
    expect(link).not.toHaveTextContent('Biggest driver');
    expect(screen.queryByTestId('overview2-driver')).not.toBeInTheDocument();
  });

  it('words the velocity-limit caveat as a lower bound, and speaks it', async () => {
    h.mc = {
      data: { ...MC, velocitySaturatedRuns: 4 },
      isLoading: false,
      error: null,
    };
    renderPage();
    expect(await screen.findByTestId('overview2-staleness')).toHaveTextContent(
      '◆ Lower bound — some runs hit the velocity limit',
    );
    expect(
      screen.getByTestId('overview2-lead-figure').querySelector('.sr-only')?.textContent,
    ).toMatch(/Lower bound — some runs hit the velocity limit$/);
  });

  it('lays the lead card out for a phone: three-up peers, 44px Why link, inline cost line', async () => {
    h.bp = 'sm';
    renderPage();
    const lead = await screen.findByTestId('overview2-lead');
    expect(lead).toHaveAttribute('data-layout', 'phone');
    expect(screen.getByTestId('overview2-peers')).toHaveClass('grid-cols-3');
    expect(screen.getByRole('link', { name: /Why this date\?/ })).toHaveClass('min-h-[44px]');
    expect(screen.getByTestId('overview2-tiles')).toHaveClass('grid-cols-2');
    expect(screen.getByTestId('not-computable')).toHaveTextContent('Cost variance');
  });

  it('keeps the driver inside one child of the flex link, and sets the three peer dates alike', async () => {
    h.bp = 'sm';
    h.mc = {
      data: { ...MC, sensitivity: [{ taskId: 't9', index: 0.8 }] },
      isLoading: false,
      error: null,
    };
    renderPage();
    const link = await screen.findByRole('link', { name: /Why this date\?/ });
    // jsdom has no flex layout: the structure is what keeps the space (the screenshot shows it).
    expect(link.childNodes).toHaveLength(1);
    expect(link.firstChild?.textContent).toBe('Why this date? Biggest driver: Pour foundation');
    const dates = screen.getAllByTestId('overview2-peer-date');
    expect(dates).toHaveLength(3);
    for (const date of dates) expect(date).toHaveClass('text-xs', 'font-mono', 'tabular-nums');
  });

  it('keeps the wide layout above the phone breakpoint', async () => {
    renderPage();
    expect(await screen.findByTestId('overview2-lead')).toHaveAttribute('data-layout', 'wide');
    expect(screen.getByTestId('overview2-peers')).not.toHaveClass('grid-cols-3');
  });
});

const SENS = [{ taskId: 't9' }] as unknown as MonteCarloResult['sensitivity'];

const CHAIN = {
  schema_version: 1,
  project_id: 'p1',
  task_id: 't9',
  computable: true,
  reason: null,
  project_finish: '2026-12-07',
  depth: 25,
  node_cap: 200,
  truncated: false,
  truncated_reason: null,
  total_links: 2,
  omitted_non_driving_count: 0,
  near_critical_threshold: { value: 5, unit: 'working_days', source: 'default' },
  calendar_id: null,
  _provenance: { computed_at: '2026-11-20T09:12:00Z' },
  nodes: [
    {
      task_id: 'fin',
      name: 'Handover',
      status: 'not_started',
      direction: 'downstream',
      hops: 1,
      early_start: null,
      early_finish: '2026-12-07',
      total_float: { value: 0, unit: 'working_days' },
      band: 'critical',
      is_critical: true,
      is_project_finish: true,
      sprint: null,
    },
    {
      task_id: 't9',
      name: 'Pour foundation',
      status: 'in_progress',
      direction: 'self',
      hops: 0,
      early_start: null,
      early_finish: '2026-11-30',
      total_float: { value: 0, unit: 'working_days' },
      band: 'critical',
      is_critical: true,
      is_project_finish: false,
      sprint: null,
    },
    {
      task_id: 'up',
      name: 'Permits',
      status: 'complete',
      direction: 'upstream',
      hops: 1,
      early_start: null,
      early_finish: '2026-11-10',
      total_float: { value: 0, unit: 'working_days' },
      band: 'complete',
      is_critical: false,
      is_project_finish: false,
      sprint: null,
    },
  ],
  edges: [],
};

describe('ProjectOverview2 — #5103 facts', () => {
  beforeEach(() => {
    h.overview = { ...OVERVIEW };
    h.mc = { data: { ...MC }, isLoading: false, error: null };
    h.tasks = [{ id: 't9', name: 'Pour foundation' }];
    h.taskOpts = [];
    h.bp = 'lg';
    h.changelog = { results: [], next_cursor: null };
    h.chain = CHAIN;
  });

  it('shows the over-allocated tile with its window, and omits it when withheld', async () => {
    h.overview = {
      ...OVERVIEW,
      over_allocated_count: 2,
      over_allocated_reason: null,
      over_allocated_window: { start: '2026-11-23', end: '2027-01-17' },
    };
    const { unmount } = renderPage();
    expect(await screen.findByText('Over-allocated')).toBeInTheDocument();
    expect(screen.getByText(/people through Jan 17, 2027/)).toBeInTheDocument();
    expect(screen.getByTestId('overview2-tiles')).toHaveClass('lg:grid-cols-4');
    unmount();
    h.overview = { ...OVERVIEW, over_allocated_count: null, over_allocated_reason: 'withheld' };
    renderPage();
    const tiles = await screen.findByTestId('overview2-tiles');
    expect(screen.queryByText('Over-allocated')).toBeNull();
    // Three tiles, three desktop columns: no empty fourth column.
    expect(tiles).toHaveClass('lg:grid-cols-3');
    expect(tiles).not.toHaveClass('lg:grid-cols-4');
  });

  it('lists changes since Monday from the changelog, and says so when there are none', async () => {
    h.overview = { ...OVERVIEW, changes_since: '2026-11-23T00:00:00Z' };
    h.changelog = {
      results: [
        {
          id: 'c1',
          object_type: 'task',
          object_kind_label: 'Milestone',
          object_id: 'm1',
          object_label: 'Beta',
          change_type: 'updated',
          history_date: '2026-11-24T10:00:00Z',
          user: null,
          changes: [],
        },
      ],
      next_cursor: null,
    };
    const { unmount } = renderPage();
    const section = await screen.findByTestId('overview2-changes');
    expect(await screen.findByText('Beta', { selector: 'li span' })).toBeInTheDocument();
    expect(section).toHaveTextContent('changed');
    unmount();
    h.changelog = { results: [], next_cursor: null };
    renderPage();
    expect(await screen.findByText('No changes since Monday.')).toBeInTheDocument();
  });

  it('offers no driver chain when the forecast names no driver', async () => {
    renderPage();
    await screen.findByTestId('overview2-lead');
    expect(screen.queryByTestId('overview2-chain-toggle')).toBeNull();
  });

  it('fetches the driver chain only when asked, and reads upstream to the finish', async () => {
    h.mc.data = { ...MC, sensitivity: SENS };
    renderPage();
    const toggle = await screen.findByTestId('overview2-chain-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('overview2-driver-chain')).toBeNull();
    await userEvent.click(toggle);
    const chain = await screen.findByTestId('overview2-driver-chain');
    const items = Array.from(chain.querySelectorAll('li')).map((li) => li.textContent ?? '');
    expect(items[0]).toContain('Permits');
    expect(items[1]).toContain('Pour foundation');
    expect(items[2]).toContain('project finish');
  });
});
