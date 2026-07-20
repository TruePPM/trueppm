import type { ReactNode } from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { BurnChart, BurnTooltip, CHART_COLORS } from './BurnChart';

// Recharts uses ResizeObserver and SVG layout — stub ResponsiveContainer so
// it renders children without needing real dimensions in jsdom.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div style={{ width: 600, height: 320 }}>{children}</div>
    ),
  };
});

// Mock html-to-image and jspdf (dynamically imported in exportPng / exportPdf)
vi.mock('html-to-image', () => ({
  toPng: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
}));
vi.mock('jspdf', () => ({
  jsPDF: vi.fn().mockImplementation(() => ({
    addImage: vi.fn(),
    save: vi.fn(),
  })),
}));

const BURN_SERIES = [
  { date: '2026-04-01', actual: 40, ideal: 40, scope: 40 },
  { date: '2026-04-07', actual: 20, ideal: 20, scope: 40 },
  { date: '2026-04-14', actual: 0, ideal: 0, scope: 40 },
];

const BURN_RESPONSE = {
  chart_type: 'burndown',
  metric: 'tasks',
  since: '2026-04-01',
  until: '2026-04-14',
  series: BURN_SERIES,
};

vi.mock('./hooks/useBurnChart', () => ({
  useBurnChart: vi.fn(),
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprintBurndown: vi.fn(),
}));

import { useBurnChart } from './hooks/useBurnChart';
import { useSprintBurndown } from '@/hooks/useSprints';

const mockUseBurnChart = vi.mocked(useBurnChart);
const mockUseSprintBurndown = vi.mocked(useSprintBurndown);

// Cast helpers — go through unknown to satisfy both tsc and ESLint no-unsafe-argument.
// TanStack Query return types have ~25 fields; for tests we only care about the
// subset the component actually reads (data, isLoading, isError, refetch).
const asBC = (v: unknown) => v as ReturnType<typeof useBurnChart>;
const asSB = (v: unknown) => v as ReturnType<typeof useSprintBurndown>;

function projectLoading() {
  mockUseBurnChart.mockReturnValue(
    asBC({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() }),
  );
  mockUseSprintBurndown.mockReturnValue(
    asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  );
}

function projectWithData() {
  mockUseBurnChart.mockReturnValue(
    asBC({ data: BURN_RESPONSE, isLoading: false, isError: false, refetch: vi.fn() }),
  );
  mockUseSprintBurndown.mockReturnValue(
    asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  );
}

function projectError() {
  mockUseBurnChart.mockReturnValue(
    asBC({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() }),
  );
  mockUseSprintBurndown.mockReturnValue(
    asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  );
}

function projectEmpty() {
  mockUseBurnChart.mockReturnValue(
    asBC({
      data: { ...BURN_RESPONSE, series: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  );
  mockUseSprintBurndown.mockReturnValue(
    asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  );
}

function sprintWithData() {
  mockUseBurnChart.mockReturnValue(
    asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  );
  mockUseSprintBurndown.mockReturnValue(
    asSB({
      data: {
        sprint: {
          id: 'sp-1',
          server_version: 1,
          short_id: 'A1',
          short_id_display: 'SP-A1',
          name: 'Sprint 1',
          goal: null,
          notes: '',
          start_date: '2026-04-01',
          finish_date: '2026-04-14',
          state: 'ACTIVE',
          target_milestone: null,
          target_milestone_detail: null,
          capacity_points: null,
          wip_limit: null,
          committed_points: 40,
          committed_task_count: 8,
          completed_points: null,
          completed_task_count: null,
          completion_ratio_points: null,
          completion_ratio_tasks: null,
          activated_at: '2026-04-01T00:00:00Z',
          closed_at: null,
          created_at: '2026-04-01T00:00:00Z',
          updated_at: '2026-04-01T00:00:00Z',
        },
        snapshots: [
          {
            id: 'sn-1',
            snapshot_date: '2026-04-07',
            remaining_points: 20,
            remaining_task_count: 4,
            completed_points: 20,
            completed_task_count: 4,
            scope_change_points: 0,
            scope_change_task_count: 0,
            created_at: '2026-04-07T00:00:00Z',
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BurnChart — project context', () => {
  it('renders section heading "Burn Chart"', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByRole('heading', { name: /burn chart/i })).toBeInTheDocument();
  });

  it('renders the variant segmented control', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByRole('group', { name: /chart variant/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /burn down/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /burn up/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /combined/i })).toBeInTheDocument();
  });

  it('marks the default variant radio as checked', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" defaultVariant="burndown" />);
    expect(screen.getByRole('radio', { name: /burn down/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /burn up/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('switches variant on click', async () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /burn up/i }));
    expect(screen.getByRole('radio', { name: /burn up/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /burn down/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('shows metric selector in project context', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByRole('combobox', { name: /metric/i })).toBeInTheDocument();
  });

  it('shows date range inputs', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByLabelText(/from date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/to date/i)).toBeInTheDocument();
  });

  it('renders loading skeleton while data is fetching', () => {
    projectLoading();
    const { container } = renderWithProviders(<BurnChart projectId="proj-1" />);
    // ChartSkeleton renders an animate-pulse div
    expect(container.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
  });

  it('renders error state with retry button', () => {
    projectError();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByText(/couldn't load chart data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders empty state when series is empty', () => {
    projectEmpty();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByText(/no tasks to chart yet/i)).toBeInTheDocument();
  });

  it('renders export button', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByRole('button', { name: /export chart/i })).toBeInTheDocument();
  });

  it('provides an sr-only text alternative for the chart SVG (issue 2175)', () => {
    projectWithData();
    const { container } = renderWithProviders(<BurnChart projectId="proj-1" />);
    // WCAG 1.1.1: a screen reader gets the summary, not an unnavigable SVG soup.
    expect(
      screen.getByText(/Burndown chart as of 2026-04-14: .*remaining versus an ideal/i),
    ).toBeInTheDocument();
    // And the SVG itself is hidden from the accessibility tree.
    expect(container.querySelector('svg')?.closest('[aria-hidden="true"]')).toBeTruthy();
  });
});

// Every chart color token must be a mode-aware CSS custom property so it adapts
// to the .dark token swap. A hardcoded rgba(0,0,0,…) / #hex value renders as
// invisible black-on-navy in dark mode (WCAG 1.4.11) — the black-on-blue
// anti-pattern of issue 1638 (the grid stroke was the first instance).
//
// The channel-triple DS-v2 tokens (`--neutral-border: 230 225 214`) must be
// wrapped in `rgb(var(--…))` for an SVG fill/stroke and carry NO `--color-`
// prefix — the dead `var(--color-neutral-border)` form silently fell back to
// black and made the whole chart illegible in dark mode (issue 1791).
describe('BurnChart — chart color tokens are mode-aware', () => {
  it('exposes only CSS custom-property tokens, never a hardcoded black rgba', () => {
    for (const [key, value] of Object.entries(CHART_COLORS)) {
      expect(value, `${key} must be a CSS custom property`).toMatch(/var\(--/);
      expect(value, `${key} must not hardcode black`).not.toMatch(/rgba?\(\s*0\s*,\s*0\s*,\s*0/);
    }
  });

  it('never references the non-existent --color- prefix (the issue 1791 dead-token bug)', () => {
    for (const [key, value] of Object.entries(CHART_COLORS)) {
      expect(value, `${key} must not use the dead --color- prefix`).not.toMatch(/var\(--color-/);
    }
  });

  it('wraps channel-triple tokens in rgb(var(--…)) so the SVG fill is a valid color', () => {
    // A bare `var(--neutral-border)` resolves to the invalid "230 225 214".
    expect(CHART_COLORS.grid).toBe('rgb(var(--neutral-border))');
    expect(CHART_COLORS.axisTick).toBe('rgb(var(--neutral-text-secondary))');
    expect(CHART_COLORS.today).toBe('rgb(var(--semantic-critical))');
    expect(CHART_COLORS.actual).toBe('rgb(var(--brand-primary))');
  });
});

describe('BurnChart — sprint context', () => {
  it('renders "Sprint Burndown" heading in sprint context', () => {
    sprintWithData();
    renderWithProviders(<BurnChart sprintId="sp-1" />);
    expect(screen.getByRole('heading', { name: /sprint burndown/i })).toBeInTheDocument();
  });

  it('does not show metric selector in sprint context', () => {
    sprintWithData();
    renderWithProviders(<BurnChart sprintId="sp-1" />);
    expect(screen.queryByRole('combobox', { name: /metric/i })).not.toBeInTheDocument();
  });

  it('shows sprint date range instead of date pickers', () => {
    sprintWithData();
    renderWithProviders(<BurnChart sprintId="sp-1" />);
    expect(screen.queryByLabelText(/from date/i)).not.toBeInTheDocument();
    expect(screen.getByText('2026-04-01 → 2026-04-14')).toBeInTheDocument();
  });

  it('renders sprint empty state when sprint starts in the future', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const futureIso = futureDate.toISOString().slice(0, 10);
    const finishIso = new Date(futureDate.getTime() + 14 * 86400000).toISOString().slice(0, 10);
    mockUseSprintBurndown.mockReturnValue(
      asSB({
        data: {
          sprint: {
            id: 'sp-future',
            server_version: 1,
            short_id: 'A2',
            short_id_display: 'SP-A2',
            name: 'Future Sprint',
            goal: null,
            notes: '',
            start_date: futureIso,
            finish_date: finishIso,
            state: 'PLANNED',
            target_milestone: null,
            target_milestone_detail: null,
            capacity_points: null,
            wip_limit: null,
            committed_points: 20,
            committed_task_count: 5,
            completed_points: null,
            completed_task_count: null,
            completion_ratio_points: null,
            completion_ratio_tasks: null,
            activated_at: null,
            closed_at: null,
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
          },
          snapshots: [],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    renderWithProviders(<BurnChart sprintId="sp-future" />);
    expect(screen.getByText(/sprint starts/i)).toBeInTheDocument();
  });

  it('renders sprint no-snapshots state for an active sprint with no data yet', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({
        data: {
          sprint: {
            id: 'sp-active-empty',
            server_version: 1,
            short_id: 'A3',
            short_id_display: 'SP-A3',
            name: 'Empty Active',
            goal: null,
            notes: '',
            start_date: '2026-04-01',
            finish_date: '2026-04-14',
            state: 'ACTIVE',
            target_milestone: null,
            target_milestone_detail: null,
            capacity_points: null,
            wip_limit: null,
            committed_points: 20,
            committed_task_count: 5,
            completed_points: null,
            completed_task_count: null,
            completion_ratio_points: null,
            completion_ratio_tasks: null,
            activated_at: '2026-04-01T00:00:00Z',
            closed_at: null,
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
          },
          snapshots: [],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    renderWithProviders(<BurnChart sprintId="sp-active-empty" />);
    expect(screen.getByText(/no snapshots yet/i)).toBeInTheDocument();
  });

  it('renders sprint with tasks metric when committed_points is null', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({
        data: {
          sprint: {
            id: 'sp-tasks',
            server_version: 1,
            short_id: 'B1',
            short_id_display: 'SP-B1',
            name: 'Tasks Sprint',
            goal: null,
            notes: '',
            start_date: '2026-04-01',
            finish_date: '2026-04-14',
            state: 'ACTIVE',
            target_milestone: null,
            target_milestone_detail: null,
            capacity_points: null,
            wip_limit: null,
            committed_points: null,
            committed_task_count: 8,
            completed_points: null,
            completed_task_count: null,
            completion_ratio_points: null,
            completion_ratio_tasks: null,
            activated_at: '2026-04-01T00:00:00Z',
            closed_at: null,
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
          },
          snapshots: [
            {
              id: 'sn-t1',
              snapshot_date: '2026-04-07',
              remaining_points: 0,
              remaining_task_count: 4,
              completed_points: 0,
              completed_task_count: 4,
              scope_change_points: 0,
              scope_change_task_count: 0,
              created_at: '2026-04-07T00:00:00Z',
            },
          ],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    renderWithProviders(<BurnChart sprintId="sp-tasks" />);
    // With committed_points=null, metric auto-selects tasks — no metric selector shown
    expect(screen.queryByRole('combobox', { name: /metric/i })).not.toBeInTheDocument();
  });

  it('renders sprint error state with retry', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() }),
    );
    renderWithProviders(<BurnChart sprintId="sp-err" />);
    expect(screen.getByText(/couldn't load chart data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('BurnChart — combined variant', () => {
  const COMBINED_RESPONSE = {
    chart_type: 'combined',
    metric: 'tasks',
    since: '2026-04-01',
    until: '2026-04-14',
    series: [
      { date: '2026-04-01', remaining: 40, completed: 0, total: 40, ideal: 40 },
      { date: '2026-04-07', remaining: 20, completed: 20, total: 40, ideal: 20 },
      { date: '2026-04-14', remaining: 0, completed: 40, total: 40, ideal: 0 },
    ],
  };

  it('renders combined chart with both remaining and completed curves', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: COMBINED_RESPONSE, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    renderWithProviders(<BurnChart projectId="proj-1" defaultVariant="combined" />);
    expect(screen.getByRole('radio', { name: /combined/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Chart area renders (not skeleton/empty/error)
    const { container } = renderWithProviders(
      <BurnChart projectId="proj-1" defaultVariant="combined" />,
    );
    expect(container.querySelector('[class*="animate-pulse"]')).not.toBeInTheDocument();
  });
});

describe('BurnChart — scope change markers', () => {
  const BURN_WITH_SCOPE_CHANGE = {
    chart_type: 'burndown',
    metric: 'tasks',
    since: '2026-04-01',
    until: '2026-04-07',
    series: [
      { date: '2026-04-01', actual: 40, ideal: 40, scope: 40 },
      { date: '2026-04-04', actual: 35, ideal: 30, scope: 40 },
      // scope jumps from 40 → 45 on this date (5-task scope add)
      { date: '2026-04-05', actual: 38, ideal: 25, scope: 45 },
      { date: '2026-04-07', actual: 30, ideal: 15, scope: 45 },
    ],
  };

  it('renders when scope changes are present in the series', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: BURN_WITH_SCOPE_CHANGE, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    // Component renders without error — scope dots are SVG elements inside Recharts
    renderWithProviders(<BurnChart projectId="proj-1" />);
    expect(screen.getByRole('heading', { name: /burn chart/i })).toBeInTheDocument();
  });
});

describe('BurnChart — null story-points banner', () => {
  it('shows the banner when all points are zero with metric=points', async () => {
    const zeroPointsSeries = [
      { date: '2026-04-01', actual: 0, ideal: 0, scope: 0 },
      { date: '2026-04-07', actual: 0, ideal: 0, scope: 0 },
    ];
    mockUseBurnChart.mockReturnValue(
      asBC({
        data: {
          chart_type: 'burndown',
          metric: 'points',
          since: '2026-04-01',
          until: '2026-04-07',
          series: zeroPointsSeries,
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    // Switch metric to points to trigger the banner
    await user.selectOptions(screen.getByRole('combobox', { name: /metric/i }), 'points');
    expect(screen.getByText(/most tasks have no story point estimates/i)).toBeInTheDocument();
  });

  it('"Use task count" button in banner switches metric back to tasks', async () => {
    const zeroPointsSeries = [{ date: '2026-04-01', actual: 0, ideal: 0, scope: 0 }];
    mockUseBurnChart.mockReturnValue(
      asBC({
        data: {
          chart_type: 'burndown',
          metric: 'points',
          since: '2026-04-01',
          until: '2026-04-01',
          series: zeroPointsSeries,
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    await user.selectOptions(screen.getByRole('combobox', { name: /metric/i }), 'points');
    const bannerBtn = screen.getByRole('button', { name: /use task count/i });
    await user.click(bannerBtn);
    // After clicking, metric resets to tasks — banner disappears
    expect(screen.queryByText(/most tasks have no story point estimates/i)).not.toBeInTheDocument();
  });
});

describe('BurnChart — export menu open/close (issue 1607)', () => {
  it('trigger click toggles the menu open then closed via aria-expanded', async () => {
    projectWithData();
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const trigger = screen.getByRole('button', { name: /export chart/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape closes an open menu', async () => {
    projectWithData();
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const trigger = screen.getByRole('button', { name: /export chart/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('outside click closes an open menu', async () => {
    projectWithData();
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const trigger = screen.getByRole('button', { name: /export chart/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('selecting a menuitem closes the menu', async () => {
    projectWithData();
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const trigger = screen.getByRole('button', { name: /export chart/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('menuitem', { name: /download png/i }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('BurnChart — export', () => {
  it('calls toPng when Download PNG menuitem is clicked', async () => {
    projectWithData();
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    // The menu is hidden by CSS in production but accessible in jsdom
    await user.click(screen.getByRole('menuitem', { name: /download png/i }));
    const { toPng } = await import('html-to-image');
    await waitFor(() => expect(toPng).toHaveBeenCalled());
  });

  it('calls toPng when Download PDF menuitem is clicked', async () => {
    projectWithData();
    const user = userEvent.setup();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    await user.click(screen.getByRole('menuitem', { name: /download pdf/i }));
    const { toPng } = await import('html-to-image');
    await waitFor(() => expect(toPng).toHaveBeenCalled());
  });
});

describe('BurnChart — date range controls', () => {
  it('updates since/until state when date inputs change', () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const fromInput = screen.getByLabelText(/from date/i);
    const toInput = screen.getByLabelText(/to date/i);
    fireEvent.change(fromInput, { target: { value: '2026-04-01' } });
    fireEvent.change(toInput, { target: { value: '2026-04-14' } });
    expect(fromInput).toHaveValue('2026-04-01');
    expect(toInput).toHaveValue('2026-04-14');
  });
});

describe('BurnChart — sprint with forecast', () => {
  it('shows trending callout for an in-progress sprint', () => {
    // Use a sprint that spans today so dayIndex > 0 and burnRate > 0
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 9);
    const finishDate = new Date(today);
    finishDate.setDate(today.getDate() + 4);
    const startIso = startDate.toISOString().slice(0, 10);
    const finishIso = finishDate.toISOString().slice(0, 10);
    const todayIso = today.toISOString().slice(0, 10);

    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({
        data: {
          sprint: {
            id: 'sp-active',
            server_version: 1,
            short_id: 'C1',
            short_id_display: 'SP-C1',
            name: 'Active Sprint',
            goal: null,
            notes: '',
            start_date: startIso,
            finish_date: finishIso,
            state: 'ACTIVE',
            target_milestone: null,
            target_milestone_detail: null,
            capacity_points: null,
            wip_limit: null,
            committed_points: null,
            committed_task_count: 20,
            completed_points: null,
            completed_task_count: null,
            completion_ratio_points: null,
            completion_ratio_tasks: null,
            activated_at: startIso + 'T00:00:00Z',
            closed_at: null,
            created_at: startIso + 'T00:00:00Z',
            updated_at: startIso + 'T00:00:00Z',
          },
          snapshots: [
            {
              id: 'sn-act',
              snapshot_date: todayIso,
              remaining_points: 0,
              remaining_task_count: 12,
              completed_points: 0,
              completed_task_count: 8,
              scope_change_points: 0,
              scope_change_task_count: 0,
              created_at: todayIso + 'T00:00:00Z',
            },
          ],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    renderWithProviders(<BurnChart sprintId="sp-active" />);
    // Trending callout renders when trendAhead is computed
    expect(screen.getByText(/trending/i)).toBeInTheDocument();
  });

  it('fires sprint refetch when retry is clicked in error state', async () => {
    const refetch = vi.fn();
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: true, refetch }),
    );
    renderWithProviders(<BurnChart sprintId="sp-err" />);
    await userEvent.setup().click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BurnTooltip — regression for issue 1304. Recharts hands a custom `content`
// element an ARRAY of series entries (the plotted row sits at
// payload[0].payload). The tooltip used to cast that array straight to the data
// point, so every field read undefined and printed 0 (Remaining/Ideal/Completed
// all "0", delta "0 ahead"). These tests feed the real Recharts shape and assert
// the actual numbers come through.
// ---------------------------------------------------------------------------
describe('BurnTooltip — reads the Recharts payload array', () => {
  it('burndown: shows real Remaining + Ideal and the "ahead" delta, not 0', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-07', remaining: 12, completed: 28, scope: 40, ideal: 20 } },
        ]}
        label="2026-04-07"
        variant="burndown"
        metric="tasks"
        scopeChanges={[]}
      />,
    );
    expect(screen.getByText(/12 tasks/)).toBeInTheDocument(); // remaining
    expect(screen.getByText(/20 tasks/)).toBeInTheDocument(); // ideal
    expect(screen.getByText(/8 tasks ahead/)).toBeInTheDocument(); // ideal 20 − remaining 12
    expect(screen.queryByText(/0 tasks ahead/)).not.toBeInTheDocument();
  });

  it('burndown: shows "behind" when remaining exceeds ideal', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-07', remaining: 30, completed: 10, scope: 40, ideal: 20 } },
        ]}
        label="2026-04-07"
        variant="burndown"
        metric="tasks"
        scopeChanges={[]}
      />,
    );
    expect(screen.getByText(/10 tasks behind/)).toBeInTheDocument(); // ideal 20 − remaining 30
  });

  it('burnup: shows the real Completed value', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-07', remaining: 12, completed: 28, scope: 40, ideal: 20 } },
        ]}
        label="2026-04-07"
        variant="burnup"
        metric="tasks"
        scopeChanges={[]}
      />,
    );
    expect(screen.getByText(/28 tasks/)).toBeInTheDocument();
    expect(screen.queryByText(/Remaining/)).not.toBeInTheDocument();
  });

  it('points metric renders the pts unit with real values', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-07', remaining: 12, completed: 28, scope: 40, ideal: 20 } },
        ]}
        label="2026-04-07"
        variant="burndown"
        metric="points"
        scopeChanges={[]}
      />,
    );
    expect(screen.getByText(/12 pts/)).toBeInTheDocument();
    expect(screen.getByText(/20 pts/)).toBeInTheDocument();
  });

  it('renders nothing when inactive', () => {
    const { container } = renderWithProviders(
      <BurnTooltip
        active={false}
        payload={[
          { payload: { date: '2026-04-07', remaining: 12, completed: 28, scope: 40, ideal: 20 } },
        ]}
        label="2026-04-07"
        variant="burndown"
        metric="tasks"
        scopeChanges={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the payload array is empty', () => {
    const { container } = renderWithProviders(
      <BurnTooltip
        active
        payload={[]}
        label="2026-04-07"
        variant="burndown"
        metric="tasks"
        scopeChanges={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a positive scope-change note when the hovered day added scope', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-05', remaining: 30, completed: 10, scope: 45, ideal: 25 } },
        ]}
        label="2026-04-05"
        variant="burndown"
        metric="tasks"
        scopeChanges={[{ date: '2026-04-05', delta: 5, newScope: 45 }]}
      />,
    );
    expect(screen.getByText(/\+5 tasks scope change/)).toBeInTheDocument();
  });

  it('renders a negative scope-change note when the hovered day removed scope', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-05', remaining: 20, completed: 10, scope: 35, ideal: 25 } },
        ]}
        label="2026-04-05"
        variant="burnup"
        metric="points"
        scopeChanges={[{ date: '2026-04-05', delta: -3, newScope: 35 }]}
      />,
    );
    // No leading "+" for a removal; unit follows the points metric.
    expect(screen.getByText(/-3 pts scope change/)).toBeInTheDocument();
  });

  it('treats a null remaining as no-data (0) rather than NaN', () => {
    renderWithProviders(
      <BurnTooltip
        active
        payload={[
          { payload: { date: '2026-04-14', remaining: null, completed: null, scope: 40, ideal: 0 } },
        ]}
        label="2026-04-14"
        variant="burndown"
        metric="tasks"
        scopeChanges={[]}
      />,
    );
    // remaining null → 0, ideal 0 → "0 ahead" (not NaN).
    expect(screen.getByText(/0 tasks ahead/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Compact mode (#1138) — the stripped board-header burndown. A whole separate
// render tree (no controls/export/legend), gated on `compact` + `sprintId`.
// ---------------------------------------------------------------------------
describe('BurnChart — compact mode', () => {
  const BASE_SPRINT = {
    id: 'sp-c',
    server_version: 1,
    short_id: 'C1',
    short_id_display: 'SP-C1',
    name: 'Compact Sprint',
    goal: null,
    notes: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: 40,
    committed_task_count: 8,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: '2026-04-01T00:00:00Z',
    closed_at: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  };

  const SNAPSHOT = {
    id: 'sn-c',
    snapshot_date: '2026-04-07',
    remaining_points: 20,
    remaining_task_count: 4,
    completed_points: 20,
    completed_task_count: 4,
    scope_change_points: 0,
    scope_change_task_count: 0,
    created_at: '2026-04-07T00:00:00Z',
  };

  function mockSprint(
    sprintOverrides: Record<string, unknown>,
    snapshots: unknown[],
    flags: { isLoading?: boolean; isError?: boolean } = {},
  ) {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({
        data:
          flags.isLoading || flags.isError
            ? undefined
            : { sprint: { ...BASE_SPRINT, ...sprintOverrides }, snapshots },
        isLoading: flags.isLoading ?? false,
        isError: flags.isError ?? false,
        refetch: vi.fn(),
      }),
    );
  }

  it('renders a pulsing skeleton while the sprint loads', () => {
    mockSprint({}, [], { isLoading: true });
    const { container } = renderWithProviders(<BurnChart sprintId="sp-c" compact />);
    expect(container.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
    // None of the full-mode chrome renders in compact mode.
    expect(screen.queryByRole('group', { name: /chart variant/i })).not.toBeInTheDocument();
  });

  it('renders "Chart unavailable" on error', () => {
    mockSprint({}, [], { isError: true });
    renderWithProviders(<BurnChart sprintId="sp-c" compact />);
    expect(screen.getByText(/chart unavailable/i)).toBeInTheDocument();
  });

  it('renders the "N of M left" caption with the derived points metric', () => {
    // committed_points 40 > 0 → metric auto-derives to points; last real
    // remaining_points snapshot is 20 → "20 of 40 pts left".
    mockSprint({}, [SNAPSHOT]);
    renderWithProviders(<BurnChart sprintId="sp-c" compact />);
    expect(screen.getByText(/20 of 40 pts/)).toBeInTheDocument();
    expect(screen.getByText(/left/)).toBeInTheDocument();
    // The chart line renders (not the "No data yet" fallback).
    expect(screen.queryByText(/no data yet/i)).not.toBeInTheDocument();
  });

  it('renders a "Closed" caption for a completed sprint', () => {
    mockSprint({ state: 'COMPLETED' }, [SNAPSHOT]);
    renderWithProviders(<BurnChart sprintId="sp-c" compact />);
    expect(screen.getByText(/closed/i)).toBeInTheDocument();
  });

  it('renders a "Not started — committed" caption for a future sprint with no snapshots', () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const futureIso = futureDate.toISOString().slice(0, 10);
    mockSprint({ start_date: futureIso, committed_points: 30 }, []);
    renderWithProviders(<BurnChart sprintId="sp-c" compact />);
    expect(screen.getByText(/not started/i)).toBeInTheDocument();
    expect(screen.getByText(/30 pts/)).toBeInTheDocument();
    expect(screen.getByText(/committed/)).toBeInTheDocument();
  });

  it('renders "No data yet" when there is no sprint data (but not loading/error)', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    renderWithProviders(<BurnChart sprintId="sp-c" compact />);
    expect(screen.getByText(/no data yet/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sprint trend + forecast + scope-change markers/legend + pending caveat
// ---------------------------------------------------------------------------
describe('BurnChart — sprint trend, forecast & scope legend', () => {
  const BASE_SPRINT = {
    id: 'sp-t',
    server_version: 1,
    short_id: 'T1',
    short_id_display: 'SP-T1',
    name: 'Trend Sprint',
    goal: null,
    notes: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: null,
    committed_task_count: 20,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: '2026-04-01T00:00:00Z',
    closed_at: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  };

  // Pin the clock so the sprint window, elapsed day index, and the snapshot date
  // all align deterministically in UTC (the component reads `new Date()` in
  // several places, and the grid days are built from start_date at UTC midnight).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sprint window straddling the pinned "today" (2026-05-10). */
  function activeWindow() {
    return { startIso: '2026-05-01', finishIso: '2026-05-14', todayIso: '2026-05-10' };
  }

  function mockTrendSprint(sprintOverrides: Record<string, unknown>, snapshots: unknown[]) {
    mockUseBurnChart.mockReturnValue(
      asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({
        data: { sprint: { ...BASE_SPRINT, ...sprintOverrides }, snapshots },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
  }

  it('shows a "behind" trend and a forecast close date when burning slowly', () => {
    const { startIso, finishIso, todayIso } = activeWindow();
    // Barely burned (remaining 18 of 20) → actual well above ideal → behind,
    // and a small positive burn rate → a finite forecast date.
    mockTrendSprint(
      { start_date: startIso, finish_date: finishIso },
      [
        {
          id: 'sn-b',
          snapshot_date: todayIso,
          remaining_points: 0,
          remaining_task_count: 18,
          completed_points: 0,
          completed_task_count: 2,
          scope_change_points: 0,
          scope_change_task_count: 0,
          created_at: todayIso + 'T00:00:00Z',
        },
      ],
    );
    renderWithProviders(<BurnChart sprintId="sp-t" compact={false} />);
    expect(screen.getByText(/behind of/i)).toBeInTheDocument();
    expect(screen.getByText(/forecast close/i)).toBeInTheDocument();
  });

  it('omits the forecast date when nothing has burned (burn rate not positive)', () => {
    const { startIso, finishIso, todayIso } = activeWindow();
    // remaining === committed → burnRate 0 → no forecast date.
    mockTrendSprint(
      { start_date: startIso, finish_date: finishIso },
      [
        {
          id: 'sn-z',
          snapshot_date: todayIso,
          remaining_points: 0,
          remaining_task_count: 20,
          completed_points: 0,
          completed_task_count: 0,
          scope_change_points: 0,
          scope_change_task_count: 0,
          created_at: todayIso + 'T00:00:00Z',
        },
      ],
    );
    renderWithProviders(<BurnChart sprintId="sp-t" />);
    expect(screen.getByText(/behind of/i)).toBeInTheDocument();
    expect(screen.queryByText(/forecast close/i)).not.toBeInTheDocument();
  });

  it('renders a "Scope added" legend + marker when a snapshot injects scope', () => {
    mockTrendSprint({}, [
      {
        id: 'sn-add',
        snapshot_date: '2026-04-07',
        remaining_points: 0,
        remaining_task_count: 10,
        completed_points: 0,
        completed_task_count: 10,
        scope_change_points: 0,
        scope_change_task_count: 5,
        created_at: '2026-04-07T00:00:00Z',
      },
    ]);
    renderWithProviders(<BurnChart sprintId="sp-t" />);
    expect(screen.getByText(/scope added/i)).toBeInTheDocument();
  });

  it('renders a "Scope removed" legend when a snapshot drops scope', () => {
    mockTrendSprint({}, [
      {
        id: 'sn-rem',
        snapshot_date: '2026-04-07',
        remaining_points: 0,
        remaining_task_count: 6,
        completed_points: 0,
        completed_task_count: 8,
        scope_change_points: 0,
        scope_change_task_count: -3,
        created_at: '2026-04-07T00:00:00Z',
      },
    ]);
    renderWithProviders(<BurnChart sprintId="sp-t" />);
    expect(screen.getByText(/scope removed/i)).toBeInTheDocument();
  });

  it('shows the pending-scope forecast caveat (ADR-0102) when the sprint has pending injections', () => {
    mockTrendSprint({ pending_count: 2 }, [
      {
        id: 'sn-p',
        snapshot_date: '2026-04-07',
        remaining_points: 0,
        remaining_task_count: 10,
        completed_points: 0,
        completed_task_count: 10,
        scope_change_points: 0,
        scope_change_task_count: 0,
        created_at: '2026-04-07T00:00:00Z',
      },
    ]);
    renderWithProviders(<BurnChart sprintId="sp-t" />);
    expect(screen.getByText(/forecast reflects accepted scope only/i)).toBeInTheDocument();
    expect(screen.getByText(/2 pending acceptance/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Project combined variant with a mid-window scope change (deriveProjectSeries
// combined branch + legend markers).
// ---------------------------------------------------------------------------
describe('BurnChart — combined variant scope change', () => {
  it('detects a total-scope jump in the combined series and shows the added legend', () => {
    mockUseBurnChart.mockReturnValue(
      asBC({
        data: {
          chart_type: 'combined',
          metric: 'tasks',
          since: '2026-04-01',
          until: '2026-04-14',
          series: [
            { date: '2026-04-01', remaining: 40, completed: 0, total: 40, ideal: 40 },
            // total 40 → 45 (a +5 scope add mid-window)
            { date: '2026-04-05', remaining: 30, completed: 15, total: 45, ideal: 20 },
            { date: '2026-04-14', remaining: 0, completed: 45, total: 45, ideal: 0 },
          ],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      }),
    );
    mockUseSprintBurndown.mockReturnValue(
      asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    );
    renderWithProviders(<BurnChart projectId="proj-1" defaultVariant="combined" />);
    expect(screen.getByText(/scope added/i)).toBeInTheDocument();
    // Combined shows the Completed and Total scope legend entries too.
    expect(screen.getByText(/^Completed$/)).toBeInTheDocument();
    expect(screen.getByText(/total scope/i)).toBeInTheDocument();
  });
});
