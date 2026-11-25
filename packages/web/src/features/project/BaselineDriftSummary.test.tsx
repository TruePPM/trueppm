import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProvidersAndRouter as render } from '@/test/utils';

import { BaselineDriftSummary } from './BaselineDriftSummary';
import type { ApiBaseline, ApiBaselineVariance } from '@/hooks/useBaselines';

const useBaselinesMock = vi.hoisted(() => vi.fn());
const useBaselineVarianceMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useBaselines', () => ({
  useBaselines: useBaselinesMock,
  useBaselineVariance: useBaselineVarianceMock,
}));

const ACTIVE: ApiBaseline = {
  id: 'b-1',
  project: 'p-1',
  name: 'Approved plan',
  created_by: 1,
  created_at: '2026-03-01T00:00:00Z',
  is_active: true,
  has_cpm_dates: true,
  task_count: 12,
};

function variance(summary: Partial<ApiBaselineVariance['summary']> = {}): ApiBaselineVariance {
  return {
    count: 3,
    baseline_id: 'b-1',
    baseline_name: 'Approved plan',
    has_cpm_dates: true,
    min_days: 1,
    added: 0,
    removed: 0,
    as_of: '2026-03-20T00:00:00Z',
    summary: {
      tasks_moved: 3,
      tasks_finishing_later: 2,
      tasks_finishing_earlier: 1,
      finish_slip_working_days_total: 7,
      top_slip: {
        task_id: 't-9',
        task_name: 'Pour foundation',
        baseline_finish: '2026-03-06',
        current_finish: '2026-03-13',
        finish_delta_working_days: 5,
        cause: 'Driven by its predecessor Excavate.',
        derivation_ref: { task_id: 't-9', quantity: 'early_finish' },
      },
      project_finish: {
        baseline_finish: '2026-03-06',
        current_finish: '2026-03-13',
        delta_working_days: 5,
      },
      ...summary,
    },
  };
}

function setState(
  baselines: { data?: ApiBaseline[]; isLoading?: boolean; isError?: boolean },
  v: { data?: ApiBaselineVariance; isLoading?: boolean; isError?: boolean } = {},
) {
  const refetch = vi.fn().mockResolvedValue(undefined);
  useBaselinesMock.mockReturnValue({ isLoading: false, isError: false, refetch, ...baselines });
  useBaselineVarianceMock.mockReturnValue({ isLoading: false, isError: false, refetch, ...v });
}

describe('BaselineDriftSummary', () => {
  beforeEach(() => {
    useBaselinesMock.mockReset();
    useBaselineVarianceMock.mockReset();
  });

  it('prints the server rollup: finish shift, counts, total slip and the top driver', () => {
    setState({ data: [ACTIVE] }, { data: variance() });
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByRole('heading', { name: 'Baseline drift' })).toBeInTheDocument();
    expect(screen.getByText('vs Approved plan')).toBeInTheDocument();
    expect(screen.getByText(/5 working days later than the baseline/)).toBeInTheDocument();
    expect(
      screen.getByText('3 tasks moved (2 finish later, 1 finish earlier).'),
    ).toBeInTheDocument();
    expect(screen.getByText('7 working days of finish slip in total.')).toBeInTheDocument();
    const top = screen.getByRole('link', { name: 'Pour foundation' });
    expect(top).toHaveAttribute('href', '/projects/p-1/tasks/t-9');
    expect(screen.getByText(/Driven by its predecessor Excavate\./)).toBeInTheDocument();
    // The variance read is keyed on the ACTIVE baseline.
    expect(useBaselineVarianceMock).toHaveBeenCalledWith('p-1', 'b-1');
  });

  it('says "earlier" in words for a pulled-in finish', () => {
    setState(
      { data: [ACTIVE] },
      {
        data: variance({
          project_finish: {
            baseline_finish: '2026-03-13',
            current_finish: '2026-03-06',
            delta_working_days: -5,
          },
        }),
      },
    );
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByText(/5 working days earlier than the baseline/)).toBeInTheDocument();
  });

  it('shows the no-movement line when nothing moved', () => {
    setState(
      { data: [ACTIVE] },
      {
        data: variance({
          tasks_moved: 0,
          tasks_finishing_later: 0,
          tasks_finishing_earlier: 0,
          finish_slip_working_days_total: 0,
          top_slip: null,
          project_finish: {
            baseline_finish: '2026-03-06',
            current_finish: '2026-03-06',
            delta_working_days: 0,
          },
        }),
      },
    );
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByText(/No task has moved since the baseline\./)).toBeInTheDocument();
    expect(screen.queryByText(/Largest slip/)).not.toBeInTheDocument();
  });

  it('says the baseline cannot be compared when no delta is comparable, not that nothing moved', () => {
    setState(
      { data: [ACTIVE] },
      {
        data: variance({
          tasks_moved: 0,
          tasks_finishing_later: 0,
          tasks_finishing_earlier: 0,
          finish_slip_working_days_total: 0,
          top_slip: null,
          project_finish: {
            baseline_finish: null,
            current_finish: '2026-03-06',
            delta_working_days: null,
          },
        }),
      },
    );
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByText(/can't be compared with the current plan yet/)).toBeInTheDocument();
    expect(screen.queryByText(/No task has moved/)).not.toBeInTheDocument();
  });

  it('says a pre-CPM baseline cannot be compared', () => {
    setState(
      { data: [{ ...ACTIVE, has_cpm_dates: false }] },
      {
        data: {
          ...variance({
            project_finish: {
              baseline_finish: null,
              current_finish: '2026-03-13',
              delta_working_days: null,
            },
          }),
          has_cpm_dates: false,
        },
      },
    );
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(
      screen.getByText(
        /captured before the schedule was first calculated, so it can't be compared/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/tasks moved/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No task has moved/)).not.toBeInTheDocument();
  });

  it('explains the empty state when there is no active baseline, without reading variance', () => {
    setState({ data: [{ ...ACTIVE, is_active: false }] });
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByText(/No active baseline/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set one in the Schedule' })).toHaveAttribute(
      'href',
      '/projects/p-1/schedule',
    );
    expect(useBaselineVarianceMock).toHaveBeenCalledWith('p-1', undefined);
  });

  it('renders a skeleton while loading, not an empty state', () => {
    setState({ data: [ACTIVE] }, { isLoading: true });
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByTestId('baseline-drift-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/No active baseline/)).not.toBeInTheDocument();
  });

  it('renders the shared error state with Retry when the variance read fails', () => {
    setState({ data: [ACTIVE] }, { isError: true });
    render(<BaselineDriftSummary projectId="p-1" />);

    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load the baseline drift.");
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
