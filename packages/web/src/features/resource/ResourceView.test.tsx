import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_SCHEDULER, ROLE_MEMBER } from '@/lib/roles';
import { ResourceView } from './ResourceView';
import type {
  AllocationResource,
  AllocationResponse,
  AllocationTask,
  UtilizationDayEntry,
  UtilizationResource,
  UtilizationResponse,
} from './resourceUtils';

const MODE_STORAGE_KEY = 'trueppm.resources.viewMode';

const utilizationMock = vi.hoisted(() => vi.fn());
const allocationMock = vi.hoisted(() => vi.fn());
const roleMock = vi.hoisted(() => vi.fn());
const triggerSchedulerMock = vi.hoisted(() => vi.fn());
// Mutable holders so a test can vary what the mocked hooks report without
// re-declaring the module factory (the factories read these at call time).
const routeProject = vi.hoisted(() => ({ id: undefined as string | undefined }));
const resolveState = vi.hoisted(() => ({ ariaMessage: null as string | null }));

vi.mock('@/hooks/useResourceUtilization', () => ({
  useResourceUtilization: utilizationMock,
}));
vi.mock('@/hooks/useResourceAllocation', () => ({
  useResourceAllocation: allocationMock,
  useInvalidateAllocation: () => {},
}));
vi.mock('@/hooks/useResolveOverallocation', () => ({
  useResolveOverallocation: () => ({
    target: null,
    isOpen: false,
    openDrawer: vi.fn(),
    closeDrawer: vi.fn(),
    ariaMessage: resolveState.ariaMessage,
  }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: roleMock }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => routeProject.id }));
vi.mock('@/hooks/useTriggerScheduler', () => ({
  useTriggerScheduler: () => triggerSchedulerMock,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function allocTask(overrides: Partial<AllocationTask> = {}): AllocationTask {
  // scheduled_start defaults to whichever early_start this call resolves to
  // (ADR-0752 §2), so pre-existing overrides that only touch
  // early_start/early_finish stay correct.
  const early_start = 'early_start' in overrides ? overrides.early_start! : '2026-01-06';
  return {
    assignment_id: 'assign-1',
    id: 'task-1',
    name: 'Draft the charter',
    early_start,
    early_finish: '2026-01-09',
    scheduled_start: early_start,
    units: '1.00',
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

function allocResource(overrides: Partial<AllocationResource> = {}): AllocationResource {
  return {
    id: 'res-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    max_units: '1.00',
    tasks: [allocTask()],
    ...overrides,
  };
}

function allocation(resources: AllocationResource[]): AllocationResponse {
  return {
    project_id: 'proj-1',
    window_start: '2026-01-05',
    window_end: '2026-02-22',
    resources,
  };
}

/** A resource booked at 100% on two overlapping tasks — over its 1.00 capacity. */
function overallocatedResource(): AllocationResource {
  return allocResource({
    id: 'res-over',
    name: 'Grace Hopper',
    tasks: [
      allocTask({ assignment_id: 'assign-a', id: 'task-a', name: 'Task A' }),
      allocTask({ assignment_id: 'assign-b', id: 'task-b', name: 'Task B' }),
    ],
  });
}

function utilDay(overrides: Partial<UtilizationDayEntry> = {}): UtilizationDayEntry {
  return {
    hours: 8,
    tasks: ['task-1'],
    load_pct: 100,
    load_band: 'on-track',
    overallocated: false,
    ...overrides,
  };
}

function utilResource(overrides: Partial<UtilizationResource> = {}): UtilizationResource {
  return {
    resource_id: 'res-1',
    resource_name: 'Ada Lovelace',
    max_units: '1.00',
    hours_per_day: 8,
    calendar_id: null,
    calendar_differs_from_project: false,
    overallocated: false,
    days: { '2026-01-06': utilDay() },
    ...overrides,
  };
}

function utilization(resources: UtilizationResource[], unassigned = 0): UtilizationResponse {
  return {
    project_id: 'proj-1',
    window: { start: '2026-01-05', end: '2026-01-11' },
    resources,
    unassigned_task_count: unassigned,
  };
}

/** Timeline mode is the default, so the allocation hook drives the view state. */
function allocationSuccess(data: AllocationResponse | undefined) {
  allocationMock.mockReturnValue({ data, status: 'success', error: null });
}

function utilizationSuccess(data: UtilizationResponse | undefined) {
  utilizationMock.mockReturnValue({ data, status: 'success', error: null });
}

function switchToUtilization() {
  fireEvent.click(screen.getByRole('tab', { name: 'Utilization' }));
}

function fitButton() {
  return screen.getByRole('button', { name: /Fit to project|Reset to today/ });
}

beforeEach(() => {
  localStorage.clear();
  routeProject.id = 'proj-1';
  resolveState.ariaMessage = null;
  roleMock.mockReturnValue({ role: ROLE_SCHEDULER, roleLabel: null, isLoading: false });
  utilizationMock.mockReturnValue({ data: undefined, status: 'idle', error: null });
  allocationMock.mockReturnValue({ data: undefined, status: 'success', error: null });
});
afterEach(() => vi.clearAllMocks());

describe('ResourceView loading/error states (#2177)', () => {
  it('renders a busy role=status skeleton while loading (not a bare "Loading" line)', () => {
    allocationMock.mockReturnValue({ data: undefined, status: 'loading', error: null });
    render(<ResourceView projectId="proj-1" />);
    const status = screen.getByRole('status', { name: 'Loading resource data' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('renders a retry-able QueryErrorState on fetch failure (not a dead-end line)', () => {
    allocationMock.mockReturnValue({ data: undefined, status: 'error', error: new Error('x') });
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load resource data.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Failed to load resource data.')).not.toBeInTheDocument();
  });

  it('renders the idle placeholder when the query has not been enabled yet', () => {
    allocationMock.mockReturnValue({ data: undefined, status: 'idle', error: null });
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByText('No project selected.')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('offers a Run Scheduler CTA when the schedule has not been computed', () => {
    allocationMock.mockReturnValue({ data: undefined, status: 'schedule-not-run', error: null });
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByText('Schedule not yet computed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run Scheduler' }));
    expect(triggerSchedulerMock).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceView permission gate (rule 94)', () => {
  it('shows the permission notice for a role below Scheduler', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, roleLabel: 'Member', isLoading: false });
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(
      screen.getByText('Resource utilization is only visible to Schedulers, Admins, and Owners.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('shows the permission notice when the role resolves to null', () => {
    roleMock.mockReturnValue({ role: null, roleLabel: null, isLoading: false });
    render(<ResourceView projectId="proj-1" />);
    expect(
      screen.getByText('Resource utilization is only visible to Schedulers, Admins, and Owners.'),
    ).toBeInTheDocument();
  });

  it('defers the decision (does not deny) while the role is still loading', () => {
    roleMock.mockReturnValue({ role: null, roleLabel: null, isLoading: true });
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(
      screen.queryByText('Resource utilization is only visible to Schedulers, Admins, and Owners.'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' })).toBeInTheDocument();
  });
});

describe('ResourceView project resolution', () => {
  it('falls back to the route project id when no projectId prop is supplied', () => {
    routeProject.id = 'proj-from-url';
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView />);
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' })).toBeInTheDocument();
    expect(allocationMock).toHaveBeenCalledWith('proj-from-url', expect.anything());
  });

  it('renders the no-project placeholder when neither the prop nor the route has an id', () => {
    routeProject.id = undefined;
    render(<ResourceView />);
    expect(screen.getByText('No project selected.')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});

describe('ResourceView persisted view mode', () => {
  it('starts in utilization mode when that is the persisted preference', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'utilization');
    utilizationSuccess(utilization([utilResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByRole('tab', { name: 'Utilization' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('falls back to timeline mode when localStorage reads throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    spy.mockRestore();
  });

  it('persists the mode when the user switches to utilization', () => {
    allocationSuccess(allocation([allocResource()]));
    utilizationSuccess(utilization([utilResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('timeline');
    switchToUtilization();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('utilization');
  });

  it('survives a localStorage write failure without breaking the view', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' })).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('ResourceView timeline mode', () => {
  it('summarises a single resource with singular nouns', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    const summary = screen.getByLabelText('Resource timeline summary');
    expect(summary).toHaveTextContent('1 resource');
    expect(summary).toHaveTextContent('1 assignment');
    expect(summary).not.toHaveTextContent('over-allocated');
  });

  it('pluralises the resource and assignment counts', () => {
    allocationSuccess(
      allocation([
        allocResource(),
        allocResource({
          id: 'res-2',
          name: 'Alan Turing',
          tasks: [
            allocTask({ assignment_id: 'assign-2', id: 'task-2', name: 'Second' }),
            allocTask({ assignment_id: 'assign-3', id: 'task-3', name: 'Third' }),
          ],
        }),
      ]),
    );
    render(<ResourceView projectId="proj-1" />);
    const summary = screen.getByLabelText('Resource timeline summary');
    expect(summary).toHaveTextContent('2 resources');
    expect(summary).toHaveTextContent('3 assignments');
  });

  it('counts over-allocated resources in the status bar and the toolbar badge', () => {
    allocationSuccess(allocation([overallocatedResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByLabelText('Resource timeline summary')).toHaveTextContent(
      '1 over-allocated',
    );
    expect(screen.getByLabelText('1 over-allocated resource')).toBeInTheDocument();
  });

  it('shows the empty-window message and hides the status bar when nobody is booked', () => {
    allocationSuccess(allocation([]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByText('No assignments in this window.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Resource timeline summary')).not.toBeInTheDocument();
  });

  it('renders the toolbar but no timeline panel when the payload is still absent', () => {
    allocationSuccess(undefined);
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' })).toBeInTheDocument();
    expect(screen.queryByText('No assignments in this window.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Resource timeline summary')).not.toBeInTheDocument();
  });

  it('runs the scheduler from the unscheduled-assignments banner', () => {
    allocationSuccess(
      allocation([
        allocResource({
          tasks: [allocTask({ early_start: null, early_finish: null })],
        }),
      ]),
    );
    render(<ResourceView projectId="proj-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Run scheduler' }));
    expect(triggerSchedulerMock).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceView resource search', () => {
  function renderTwoResources() {
    allocationSuccess(
      allocation([
        allocResource(),
        allocResource({
          id: 'res-2',
          name: 'Alan Turing',
          tasks: [allocTask({ assignment_id: 'assign-2', id: 'task-2' })],
        }),
      ]),
    );
    render(<ResourceView projectId="proj-1" />);
  }

  it('narrows the rows to the matching resource (case-insensitive)', () => {
    renderTwoResources();
    fireEvent.change(screen.getByLabelText('Filter resources by name'), {
      target: { value: 'ADA' },
    });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Alan Turing')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Resource timeline summary')).toHaveTextContent('1 resource');
  });

  it('reports a filter miss distinctly from an empty window', () => {
    renderTwoResources();
    fireEvent.change(screen.getByLabelText('Filter resources by name'), {
      target: { value: 'nobody' },
    });
    expect(screen.getByText('No resources match the filter.')).toBeInTheDocument();
    expect(screen.queryByText('No assignments in this window.')).not.toBeInTheDocument();
  });

  it('treats a whitespace-only query as no filter at all', () => {
    renderTwoResources();
    fireEvent.change(screen.getByLabelText('Filter resources by name'), {
      target: { value: '   ' },
    });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
  });
});

describe('ResourceView utilization mode', () => {
  it('queries utilization for the project and renders the load grid', () => {
    allocationSuccess(allocation([allocResource()]));
    utilizationSuccess(utilization([utilResource()]));
    render(<ResourceView projectId="proj-1" />);
    switchToUtilization();

    expect(utilizationMock).toHaveBeenLastCalledWith(
      'proj-1',
      expect.any(String),
      expect.any(String),
    );
    // Allocation is disabled while utilization is on screen.
    expect(allocationMock).toHaveBeenLastCalledWith(undefined, expect.anything());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('shows the utilization empty-window message when nobody is assigned', () => {
    utilizationSuccess(utilization([]));
    render(<ResourceView projectId="proj-1" />);
    switchToUtilization();
    expect(screen.getByText('No resources assigned in this window.')).toBeInTheDocument();
  });

  it('surfaces the unassigned-task count in the toolbar', () => {
    utilizationSuccess(utilization([utilResource()], 3));
    render(<ResourceView projectId="proj-1" />);
    switchToUtilization();
    expect(screen.getByText('3 tasks without assignment')).toBeInTheDocument();
  });

  it('drops the over-allocation badge when leaving timeline mode', () => {
    allocationSuccess(allocation([overallocatedResource()]));
    utilizationSuccess(utilization([utilResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByLabelText('1 over-allocated resource')).toBeInTheDocument();
    switchToUtilization();
    expect(screen.queryByLabelText('1 over-allocated resource')).not.toBeInTheDocument();
  });

  it('uses the utilization query status for the view state', () => {
    utilizationMock.mockReturnValue({ data: undefined, status: 'success', error: null });
    allocationMock.mockReturnValue({ data: undefined, status: 'error', error: new Error('x') });
    localStorage.setItem(MODE_STORAGE_KEY, 'utilization');
    render(<ResourceView projectId="proj-1" />);
    // The failed allocation query must not leak into utilization mode.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' })).toBeInTheDocument();
  });
});

describe('ResourceView window navigation', () => {
  function windowLabel(): string {
    const el = screen.getByText('→').closest('[aria-label^="Date window"]');
    return el?.getAttribute('aria-label') ?? '';
  }

  it('steps the window forward, back, and home again', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    const initial = windowLabel();

    fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
    const next = windowLabel();
    expect(next).not.toBe(initial);

    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    expect(windowLabel()).toBe(initial);

    fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(windowLabel()).toBe(initial);
  });

  it('cancels "fit to project" as soon as the user navigates away', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" projectStartDate="2026-01-05" />);
    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Reset to today');

    fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
    expect(fitButton()).toHaveTextContent('Fit to project');
  });
});

describe('ResourceView fit to project', () => {
  it('fits the window to the allocation span and resets on a second press', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" projectStartDate="2026-01-05" />);
    const before = screen.getByRole('toolbar', { name: 'Resource toolbar' }).textContent;

    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Reset to today');
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' }).textContent).not.toBe(before);

    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Fit to project');
    expect(screen.getByRole('toolbar', { name: 'Resource toolbar' }).textContent).toBe(before);
  });

  it('does nothing when the project has no start date to fit to', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Fit to project');
  });

  it('does nothing in timeline mode while the allocation payload is missing', () => {
    allocationSuccess(undefined);
    render(<ResourceView projectId="proj-1" projectStartDate="2026-01-05" />);
    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Fit to project');
  });

  it('fits the window to the utilization span in utilization mode', () => {
    utilizationSuccess(utilization([utilResource()]));
    render(<ResourceView projectId="proj-1" projectStartDate="2026-01-05" />);
    switchToUtilization();
    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Reset to today');
  });

  it('does nothing in utilization mode while the utilization payload is missing', () => {
    utilizationMock.mockReturnValue({ data: undefined, status: 'success', error: null });
    render(<ResourceView projectId="proj-1" projectStartDate="2026-01-05" />);
    switchToUtilization();
    fireEvent.click(fitButton());
    expect(fitButton()).toHaveTextContent('Fit to project');
  });
});

describe('ResourceView "My allocation" shortcut', () => {
  it('scopes the allocation query to the current user when toggled on', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" currentUserResourceId="res-1" />);
    const toggle = screen.getByRole('button', { name: 'My allocation' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'My allocation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(allocationMock).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ resource: ['res-1'] }),
    );
  });

  it('leaves the query unscoped when the user has no resource record', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    expect(screen.queryByRole('button', { name: 'My allocation' })).not.toBeInTheDocument();
    expect(allocationMock).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ resource: undefined }),
    );
  });
});

describe('ResourceView status filters', () => {
  it('drops a status from the query when its pill is unchecked', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    fireEvent.click(screen.getByLabelText('Not started'));
    expect(allocationMock).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ status: ['IN_PROGRESS'] }),
    );
  });

  it('sends no status filter at all once every pill is unchecked', () => {
    allocationSuccess(allocation([allocResource()]));
    render(<ResourceView projectId="proj-1" />);
    fireEvent.click(screen.getByLabelText('Not started'));
    fireEvent.click(screen.getByLabelText('In progress'));
    expect(allocationMock).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ status: undefined }),
    );
  });
});

describe('ResourceView overallocation live region', () => {
  // ResourceView's own live region is a direct child of the rendered fragment —
  // scoping to `:scope >` keeps it distinct from the timeline's nested sr-only
  // summary, which carries the same aria-live/aria-atomic pair.
  const LIVE_REGION = ':scope > div[aria-live="polite"][aria-atomic="true"]';

  it('leaves the live region empty when nothing has been announced', () => {
    allocationSuccess(allocation([allocResource()]));
    const { container } = render(<ResourceView projectId="proj-1" />);
    const live = container.querySelector(LIVE_REGION);
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe('');
  });

  it('mirrors the drawer announcement into the live region', () => {
    resolveState.ariaMessage = 'Overallocation: Ada Lovelace is at 150% on 2026-01-06.';
    allocationSuccess(allocation([allocResource()]));
    const { container } = render(<ResourceView projectId="proj-1" />);
    const live = container.querySelector(LIVE_REGION);
    expect(live?.textContent).toBe('Overallocation: Ada Lovelace is at 150% on 2026-01-06.');
  });
});
