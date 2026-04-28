import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { EstimatesTab } from './EstimatesTab';
import type { Task } from '@/types';

const patchMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: {} }),
);
const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { estimate_status: 'accepted' } }),
);

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock, post: postMock },
}));

const baseTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Design sprint',
  start: '2026-04-01',
  finish: '2026-04-10',
  duration: 7,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
};

beforeEach(() => vi.clearAllMocks());

describe('EstimatesTab — open mode', () => {
  it('renders three input fields', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByLabelText(/Optimistic/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Most Likely/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pessimistic/i)).toBeInTheDocument();
  });

  it('inputs are enabled for non-schedulers in open mode', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByLabelText(/Optimistic/i)).not.toBeDisabled();
  });

  it('shows PERT panel when all three are set and accepted', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...baseTask, optimisticDuration: 3, mostLikelyDuration: 5, pessimisticDuration: 9 }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByRole('region', { name: /PERT/i })).toBeInTheDocument();
    // E = (3 + 4*5 + 9) / 6 = 32/6 ≈ 5.3
    expect(screen.getByText(/5\.3 days/)).toBeInTheDocument();
  });

  it('does not show PERT panel when only two fields are set', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...baseTask, optimisticDuration: 3, mostLikelyDuration: 5 }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.queryByRole('region', { name: /PERT/i })).not.toBeInTheDocument();
  });
});

describe('EstimatesTab — pm_only mode', () => {
  it('disables inputs for non-schedulers', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="pm_only"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByLabelText(/Optimistic/i)).toBeDisabled();
    expect(screen.getByLabelText(/Most Likely/i)).toBeDisabled();
    expect(screen.getByLabelText(/Pessimistic/i)).toBeDisabled();
  });

  it('enables inputs for schedulers', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="pm_only"
        userIsScheduler={true}
      />,
    );
    expect(screen.getByLabelText(/Optimistic/i)).not.toBeDisabled();
  });
});

describe('EstimatesTab — suggest_approve mode', () => {
  it('shows pending banner when estimate_status is pending', () => {
    renderWithProviders(
      <EstimatesTab
        task={{
          ...baseTask,
          optimisticDuration: 3,
          mostLikelyDuration: 5,
          pessimisticDuration: 9,
          estimateStatus: 'pending',
        }}
        projectId="p1"
        estimationMode="suggest_approve"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Pending approval/i)).toBeInTheDocument();
  });

  it('shows Accept button for schedulers when pending', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...baseTask, estimateStatus: 'pending' }}
        projectId="p1"
        estimationMode="suggest_approve"
        userIsScheduler={true}
      />,
    );
    expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument();
  });

  it('does not show Accept button for non-schedulers', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...baseTask, estimateStatus: 'pending' }}
        projectId="p1"
        estimationMode="suggest_approve"
        userIsScheduler={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /Accept/i })).not.toBeInTheDocument();
  });

  it('hides PERT panel for pending estimates', () => {
    renderWithProviders(
      <EstimatesTab
        task={{
          ...baseTask,
          optimisticDuration: 3,
          mostLikelyDuration: 5,
          pessimisticDuration: 9,
          estimateStatus: 'pending',
        }}
        projectId="p1"
        estimationMode="suggest_approve"
        userIsScheduler={false}
      />,
    );
    expect(screen.queryByRole('region', { name: /PERT/i })).not.toBeInTheDocument();
  });

  it('shows PERT panel for accepted estimates', () => {
    renderWithProviders(
      <EstimatesTab
        task={{
          ...baseTask,
          optimisticDuration: 3,
          mostLikelyDuration: 5,
          pessimisticDuration: 9,
          estimateStatus: 'accepted',
        }}
        projectId="p1"
        estimationMode="suggest_approve"
        userIsScheduler={true}
      />,
    );
    expect(screen.getByRole('region', { name: /PERT/i })).toBeInTheDocument();
  });

  it('shows guidance for non-scheduler in suggest_approve with no pending banner', () => {
    // estimateStatus null, estimationMode suggest_approve, non-scheduler
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="suggest_approve"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByText(/awaiting scheduler review|submitted for scheduler approval/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Blur handlers and debounced update
// ---------------------------------------------------------------------------

describe('EstimatesTab — blur handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fires a PATCH for optimistic duration after blur + debounce', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    const input = screen.getByLabelText(/Optimistic/i);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    act(() => { vi.advanceTimersByTime(400); });
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ optimistic_duration: 5 }),
    );
  });

  it('fires a PATCH for most-likely duration after blur + debounce', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    const input = screen.getByLabelText(/Most Likely/i);
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.blur(input);
    act(() => { vi.advanceTimersByTime(400); });
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ most_likely_duration: 8 }),
    );
  });

  it('fires a PATCH for pessimistic duration after blur + debounce', () => {
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    const input = screen.getByLabelText(/Pessimistic/i);
    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.blur(input);
    act(() => { vi.advanceTimersByTime(400); });
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ pessimistic_duration: 15 }),
    );
  });

  it('sends null when the field is cleared (empty string)', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...baseTask, optimisticDuration: 5 }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    const input = screen.getByLabelText(/Optimistic/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    act(() => { vi.advanceTimersByTime(400); });
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ optimistic_duration: null }),
    );
  });
});
