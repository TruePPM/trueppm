import type { ReactNode } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { BurnChart } from './BurnChart';

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
  { date: '2026-04-14', actual: 0,  ideal: 0,  scope: 40 },
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
  mockUseBurnChart.mockReturnValue(asBC({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() }));
  mockUseSprintBurndown.mockReturnValue(asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
}

function projectWithData() {
  mockUseBurnChart.mockReturnValue(asBC({ data: BURN_RESPONSE, isLoading: false, isError: false, refetch: vi.fn() }));
  mockUseSprintBurndown.mockReturnValue(asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
}

function projectError() {
  mockUseBurnChart.mockReturnValue(asBC({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() }));
  mockUseSprintBurndown.mockReturnValue(asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
}

function projectEmpty() {
  mockUseBurnChart.mockReturnValue(asBC({ data: { ...BURN_RESPONSE, series: [] }, isLoading: false, isError: false, refetch: vi.fn() }));
  mockUseSprintBurndown.mockReturnValue(asSB({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
}

function sprintWithData() {
  mockUseBurnChart.mockReturnValue(asBC({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
  mockUseSprintBurndown.mockReturnValue(asSB({
    data: {
      sprint: {
        id: 'sp-1', server_version: 1, short_id: 'A1', short_id_display: 'SP-A1',
        name: 'Sprint 1', goal: null, notes: '',
        start_date: '2026-04-01', finish_date: '2026-04-14',
        state: 'ACTIVE',
        target_milestone: null, target_milestone_detail: null,
        committed_points: 40, committed_task_count: 8,
        completed_points: null, completed_task_count: null,
        completion_ratio_points: null, completion_ratio_tasks: null,
        activated_at: '2026-04-01T00:00:00Z', closed_at: null,
        created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
      },
      snapshots: [
        {
          id: 'sn-1', snapshot_date: '2026-04-07',
          remaining_points: 20, remaining_task_count: 4,
          completed_points: 20, completed_task_count: 4,
          scope_change_points: 0, scope_change_task_count: 0,
          created_at: '2026-04-07T00:00:00Z',
        },
      ],
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  }));
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
    expect(screen.getByRole('radio', { name: /burn down/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /burn up/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('switches variant on click', async () => {
    projectWithData();
    renderWithProviders(<BurnChart projectId="proj-1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /burn up/i }));
    expect(screen.getByRole('radio', { name: /burn up/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /burn down/i })).toHaveAttribute('aria-checked', 'false');
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
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
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
});
