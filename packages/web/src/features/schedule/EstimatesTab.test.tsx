import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { EstimatesTab } from './EstimatesTab';
import { TaskDraftContext, type TaskDraftContextValue } from './TaskDraftContext';
import type { ReactElement } from 'react';
import type { Task } from '@/types';

const patchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));
const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { estimate_status: 'accepted' } }),
);
const getMock = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { count: 0, results: [] } }));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock, post: postMock, get: getMock },
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
  notes: '',
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
};

beforeEach(() => vi.clearAllMocks());

describe('EstimatesTab — open mode', () => {
  it('renders three input fields', () => {
    renderWithProviders(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
    );
    expect(screen.getByLabelText(/Optimistic/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Most Likely/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pessimistic/i)).toBeInTheDocument();
  });

  it('inputs are enabled for non-schedulers in open mode', () => {
    renderWithProviders(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
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
    expect(
      screen.getByText(/awaiting scheduler review|submitted for scheduler approval/i),
    ).toBeInTheDocument();
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

  it('fires a PATCH for optimistic duration after blur + debounce', async () => {
    renderWithProviders(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
    );
    const input = screen.getByLabelText(/Optimistic/i);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    await vi.runAllTimersAsync();
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ optimistic_duration: 5 }),
    );
  });

  it('fires a PATCH for most-likely duration after blur + debounce', async () => {
    renderWithProviders(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
    );
    const input = screen.getByLabelText(/Most Likely/i);
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.blur(input);
    await vi.runAllTimersAsync();
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ most_likely_duration: 8 }),
    );
  });

  it('fires a PATCH for pessimistic duration after blur + debounce', async () => {
    renderWithProviders(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
    );
    const input = screen.getByLabelText(/Pessimistic/i);
    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.blur(input);
    await vi.runAllTimersAsync();
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ pessimistic_duration: 15 }),
    );
  });

  it('sends null when the field is cleared (empty string)', async () => {
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
    await vi.runAllTimersAsync();
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/t1/'),
      expect.objectContaining({ optimistic_duration: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint effort section (issue #366)
// ---------------------------------------------------------------------------

const sprintTask: Task = {
  ...baseTask,
  id: 'ts1',
  sprintId: 'sprint-1',
  storyPoints: 8,
  remainingPoints: 5,
};

describe('EstimatesTab — sprint effort section', () => {
  it('does not show sprint effort section when task has no sprint', () => {
    renderWithProviders(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
    );
    expect(screen.queryByText(/Sprint Effort/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Committed.*pts/i)).not.toBeInTheDocument();
  });

  it('shows sprint effort section when task has a sprintId', () => {
    renderWithProviders(
      <EstimatesTab
        task={sprintTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByText(/Sprint Effort/i)).toBeInTheDocument();
  });

  it('shows committed story points as read-only', () => {
    renderWithProviders(
      <EstimatesTab
        task={sprintTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByLabelText(/Committed story points \(read-only\)/i)).toHaveTextContent('8');
  });

  it('shows em-dash when storyPoints is null', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...sprintTask, storyPoints: null }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
    );
    expect(screen.getByLabelText(/Committed story points \(read-only\)/i)).toHaveTextContent('—');
  });

  it('shows remaining-points field disabled when sprint is not active', () => {
    renderWithProviders(
      <EstimatesTab
        task={sprintTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
        sprintIsActive={false}
      />,
    );
    expect(screen.getByLabelText(/Remaining \(pts\)/i)).toBeDisabled();
  });

  it('shows remaining-points field enabled when sprint is active', () => {
    renderWithProviders(
      <EstimatesTab
        task={sprintTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
        sprintIsActive={true}
      />,
    );
    expect(screen.getByLabelText(/Remaining \(pts\)/i)).not.toBeDisabled();
  });

  it('pre-fills remaining-points with current value', () => {
    renderWithProviders(
      <EstimatesTab
        task={sprintTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
        sprintIsActive={true}
      />,
    );
    expect(screen.getByLabelText(/Remaining \(pts\)/i)).toHaveValue(5);
  });

  it('disables remaining-points when status is COMPLETE', () => {
    renderWithProviders(
      <EstimatesTab
        task={{ ...sprintTask, status: 'COMPLETE', remainingPoints: 0 }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
        sprintIsActive={true}
      />,
    );
    expect(screen.getByLabelText(/Remaining \(pts\)/i)).toBeDisabled();
    expect(screen.getByText(/zeroed automatically/i)).toBeInTheDocument();
  });

  it('fires a PATCH for remaining_points on blur when active', async () => {
    vi.useFakeTimers();
    renderWithProviders(
      <EstimatesTab
        task={sprintTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
        sprintIsActive={true}
      />,
    );
    const input = screen.getByLabelText(/Remaining \(pts\)/i);
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    await vi.runAllTimersAsync();
    expect(patchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks/ts1/'),
      expect.objectContaining({ remaining_points: 3 }),
    );
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Velocity-calibration suggestion banner (ADR-0065)
// ---------------------------------------------------------------------------

const suggestionFixture = {
  id: 'sugg-1',
  task: 't1',
  sprint_id: 's-12',
  sprint_name: 'Sprint 12',
  suggested_duration: 4,
  team_velocity_per_day: '1.500',
  flag_for_review: false,
  is_pending: true,
  created_at: '2026-05-01T00:00:00Z',
  accepted_at: null,
  accepted_by: null,
  dismissed_at: null,
  dismissed_by: null,
};

describe('EstimatesTab — velocity suggestion banner', () => {
  // EstimatesTab now reads the project (via useIterationLabel → useProject) in
  // addition to the velocity-suggestions endpoint (#862). Both go through
  // apiClient.get, so the mock routes by URL: /projects/ resolves the project
  // detail (label falls back to the default "Sprint"), /velocity-suggestions/
  // returns the fixture set per test.
  function routeGet(suggestionResults: unknown[]) {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/velocity-suggestions/')) {
        return Promise.resolve({
          data: { count: suggestionResults.length, results: suggestionResults },
        });
      }
      return Promise.resolve({ data: { id: 'p1', name: 'P1' } });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render the banner for non-admin users', () => {
    routeGet([suggestionFixture]);
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={false}
      />,
    );
    // useVelocitySuggestions stays disabled when userIsAdmin is false, so the
    // banner never renders even if the API would have returned a row.
    expect(screen.queryByLabelText(/Velocity calibration suggestion/i)).not.toBeInTheDocument();
    // The project read may fire (label resolution), but the suggestions
    // endpoint must never be hit for a non-admin.
    expect(getMock).not.toHaveBeenCalledWith(expect.stringContaining('/velocity-suggestions/'));
  });

  it('renders the banner when a pending suggestion exists and user is admin', async () => {
    routeGet([suggestionFixture]);
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Velocity calibration suggestion/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Sprint 12/)).toBeInTheDocument();
    expect(screen.getByText(/4d/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
  });

  it('hides the banner when suggested_duration is suppressed by the velocity gate (#1099)', async () => {
    // A PM at the team-private default is below the velocity audience, so the
    // server nulls suggested_duration. With no value to revise to, the prompt
    // must hide rather than render an empty "suggests d".
    routeGet([{ ...suggestionFixture, suggested_duration: null, team_velocity_per_day: null }]);
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
    );
    // The suggestions query fires (admin), but the banner stays absent.
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith(expect.stringContaining('/velocity-suggestions/')),
    );
    expect(screen.queryByLabelText(/Velocity calibration suggestion/i)).not.toBeInTheDocument();
  });

  it('shows current vs suggested duration when most_likely_duration is set', async () => {
    routeGet([suggestionFixture]);
    renderWithProviders(
      <EstimatesTab
        task={{ ...baseTask, mostLikelyDuration: 7 }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Velocity calibration suggestion/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/currently/i)).toBeInTheDocument();
    expect(screen.getByText(/7d/)).toBeInTheDocument();
  });

  it('Accept button posts to the accept endpoint', async () => {
    getMock.mockResolvedValue({ data: { count: 1, results: [suggestionFixture] } });
    postMock.mockResolvedValueOnce({
      data: { ...suggestionFixture, accepted_at: '2026-05-02T00:00:00Z' },
    });
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept/i }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/velocity-suggestions/sugg-1/accept/'),
    );
  });

  it('Dismiss button posts to the dismiss endpoint', async () => {
    getMock.mockResolvedValue({ data: { count: 1, results: [suggestionFixture] } });
    postMock.mockResolvedValueOnce({
      data: { ...suggestionFixture, dismissed_at: '2026-05-02T00:00:00Z' },
    });
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/velocity-suggestions/sugg-1/dismiss/'),
    );
  });

  it('does not render the banner when no pending suggestion is returned', async () => {
    getMock.mockResolvedValueOnce({ data: { count: 0, results: [] } });
    renderWithProviders(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
    );
    // Wait for the query to settle; banner remains absent.
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Velocity calibration suggestion/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Drawer draft mode (#1985, ADR-0440) — O/M/P batch behind the Save bar via
// TaskDraftContext instead of committing on blur. Absent (the tests above), the
// immediate debounced-PATCH fallback still runs — that backward-compat is proven
// by every test above rendering EstimatesTab with no provider.
// ---------------------------------------------------------------------------

function makeDraft(overrides: Partial<TaskDraftContextValue> = {}): TaskDraftContextValue {
  return {
    taskId: 't1',
    estimates: {
      optimistic_duration: null,
      most_likely_duration: null,
      pessimistic_duration: null,
    },
    setEstimate: vi.fn(),
    changed: {
      optimistic_duration: false,
      most_likely_duration: false,
      pessimistic_duration: false,
    },
    commitEstimatesFromServer: vi.fn(),
    ...overrides,
  };
}

function renderWithDraft(ui: ReactElement, draft: TaskDraftContextValue) {
  return renderWithProviders(
    <TaskDraftContext.Provider value={draft}>{ui}</TaskDraftContext.Provider>,
  );
}

describe('EstimatesTab — drawer draft mode (#1985, ADR-0440)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stages an estimate edit into the draft instead of firing a PATCH', async () => {
    vi.useFakeTimers();
    const draft = makeDraft();
    renderWithDraft(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
      draft,
    );
    const input = screen.getByLabelText(/Optimistic/i);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    await vi.runAllTimersAsync();
    expect(draft.setEstimate).toHaveBeenCalledWith('optimistic_duration', 5);
    // No debounced single-field PATCH in draft mode — persistence is the drawer's Save.
    expect(patchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('stages null when a field is cleared', () => {
    const draft = makeDraft({
      estimates: { optimistic_duration: 5, most_likely_duration: null, pessimistic_duration: null },
    });
    renderWithDraft(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
      draft,
    );
    fireEvent.change(screen.getByLabelText(/Optimistic/i), { target: { value: '' } });
    expect(draft.setEstimate).toHaveBeenCalledWith('optimistic_duration', null);
  });

  it('PERT preview reflects the live draft values, not the last-saved task', () => {
    // task.* are all null — if PERT read the task the panel would be hidden. It
    // shows because it reads the draft: E = (3 + 4*5 + 9) / 6 = 5.3.
    const draft = makeDraft({
      estimates: { optimistic_duration: 3, most_likely_duration: 5, pessimistic_duration: 9 },
    });
    renderWithDraft(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
      draft,
    );
    expect(screen.getByRole('region', { name: /PERT/i })).toBeInTheDocument();
    expect(screen.getByText(/5\.3 days/)).toBeInTheDocument();
  });

  it('shows the value staged in the draft, overriding the saved task value', () => {
    const draft = makeDraft({
      estimates: {
        optimistic_duration: 12,
        most_likely_duration: null,
        pessimistic_duration: null,
      },
    });
    renderWithDraft(
      <EstimatesTab
        task={{ ...baseTask, optimisticDuration: 3 }}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={false}
      />,
      draft,
    );
    expect(screen.getByLabelText(/Optimistic/i)).toHaveValue(12);
  });

  it('renders the unsaved • marker only on a changed estimate field', () => {
    const draft = makeDraft({
      estimates: { optimistic_duration: null, most_likely_duration: 5, pessimistic_duration: null },
      changed: {
        optimistic_duration: false,
        most_likely_duration: true,
        pessimistic_duration: false,
      },
    });
    renderWithDraft(
      <EstimatesTab task={baseTask} projectId="p1" estimationMode="open" userIsScheduler={false} />,
      draft,
    );
    expect(screen.getAllByTitle('Unsaved')).toHaveLength(1);
  });

  it('blocks Accept (aria-disabled, no POST) while an estimate edit is staged, but leaves Dismiss enabled', async () => {
    getMock.mockResolvedValue({ data: { count: 1, results: [suggestionFixture] } });
    const draft = makeDraft({
      changed: {
        optimistic_duration: false,
        most_likely_duration: true,
        pessimistic_duration: false,
      },
    });
    renderWithDraft(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
      draft,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument(),
    );
    const accept = screen.getByRole('button', { name: /Accept/i });
    // Accessible-disabled: still in the tree/tab order, marked aria-disabled, with
    // an sr-only reason wired via aria-describedby.
    expect(accept).toHaveAttribute('aria-disabled', 'true');
    expect(accept).not.toBeDisabled();
    expect(
      document.getElementById(accept.getAttribute('aria-describedby') ?? ''),
    ).toHaveTextContent(/Save or cancel your estimate changes first/i);
    // Clicking it is a no-op — no accept POST fires while staged.
    fireEvent.click(accept);
    expect(postMock).not.toHaveBeenCalled();
    // Dismiss discards the suggestion (no estimate write) so it stays enabled.
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeEnabled();
  });

  it('re-baselines the estimate slice after a successful Accept', async () => {
    getMock.mockResolvedValue({ data: { count: 1, results: [suggestionFixture] } });
    postMock.mockResolvedValueOnce({
      data: { ...suggestionFixture, accepted_at: '2026-05-02T00:00:00Z' },
    });
    const draft = makeDraft(); // clean — Accept is enabled
    renderWithDraft(
      <EstimatesTab
        task={baseTask}
        projectId="p1"
        estimationMode="open"
        userIsScheduler={true}
        userIsAdmin={true}
      />,
      draft,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept/i }));
    // Accept wrote most_likely server-side (4); the draft baseline must move to it
    // so a later Save can't clobber the accepted value.
    await waitFor(() =>
      expect(draft.commitEstimatesFromServer).toHaveBeenCalledWith(
        expect.objectContaining({ most_likely_duration: 4 }),
      ),
    );
  });
});
