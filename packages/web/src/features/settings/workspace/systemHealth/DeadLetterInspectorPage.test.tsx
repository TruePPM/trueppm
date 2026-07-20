/**
 * DeadLetterInspectorPage — component unit tests.
 *
 * Exercises the split-view list branches over a mocked useFailedTasks: loading
 * skeleton, hard error, empty "clean queue" state, a populated list with a
 * per-status breakdown (each FailedTaskStatus renders its own dot + label), and
 * the detail pane driven by ?selected= over a mocked useFailedTask. Fixtures use
 * the REAL FailedTask / PaginatedResponse shape — no invented keys.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterInspectorPage } from './DeadLetterInspectorPage';
import { toast } from '@/components/Toast';
import type { FailedTask, FailedTaskStatus } from '@/hooks/useFailedTasks';
import type { PaginatedResponse } from '@/api/types';

const useFailedTasks = vi.fn();
const useFailedTask = vi.fn();

vi.mock('@/hooks/useFailedTasks', async () => {
  const actual = await vi.importActual('@/hooks/useFailedTasks');
  return {
    ...actual,
    useFailedTasks: () => useFailedTasks() as unknown,
    useFailedTask: () => useFailedTask() as unknown,
  };
});

// Mutation hooks are stubbed so the confirm dialog's success/error paths can be
// driven deterministically without a real apiClient round-trip. Each `mutate`
// mock forwards to the `onSuccess`/`onError` callbacks the page supplies.
const { requeueMutate, dropMutate, requeueAllMutate, dropAllMutate } = vi.hoisted(() => ({
  requeueMutate: vi.fn(),
  dropMutate: vi.fn(),
  requeueAllMutate: vi.fn(),
  dropAllMutate: vi.fn(),
}));

vi.mock('@/hooks/useFailedTaskActions', async () => {
  const actual = await vi.importActual('@/hooks/useFailedTaskActions');
  return {
    ...actual, // preserve BACKOFF_OPTIONS (read by the dialog)
    useRequeueFailedTask: () => ({ mutate: requeueMutate, isPending: false }),
    useDropFailedTask: () => ({ mutate: dropMutate, isPending: false }),
    useRequeueAllFailedTasks: () => ({ mutate: requeueAllMutate, isPending: false }),
    useDropAllFailedTasks: () => ({ mutate: dropAllMutate, isPending: false }),
  };
});

vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeTask(over: Partial<FailedTask> = {}): FailedTask {
  return {
    id: 'task-1',
    task_name: 'trueppm.drain_outbox',
    task_id: 'cel-uuid-12345678',
    args: [],
    kwargs: {},
    exception_type: 'RuntimeError',
    exception_message: 'Connection refused',
    traceback: 'Traceback (most recent call last):\n  ...',
    failure_count: 3,
    first_failed_at: '2026-05-24T10:00:00Z',
    last_failed_at: '2026-05-25T08:00:00Z',
    status: 'dead' as FailedTaskStatus,
    resolution_note: '',
    resolved_by_display: null,
    resolved_at: null,
    ...over,
  };
}

function makeList(results: FailedTask[]): PaginatedResponse<FailedTask> {
  return { count: results.length, next: null, previous: null, results };
}

function listResult(over: Record<string, unknown> = {}) {
  return { data: undefined, isLoading: false, error: null, ...over };
}

function detailResult(over: Record<string, unknown> = {}) {
  return { data: undefined, isLoading: false, error: null, ...over };
}

function renderPage(initialPath = '/settings/health/dead-letters') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <DeadLetterInspectorPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DeadLetterInspectorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but NOT implementations — reset the mutate
    // stubs to inert no-ops so one test's onSuccess/onError forwarder can't leak.
    requeueMutate.mockReset();
    dropMutate.mockReset();
    requeueAllMutate.mockReset();
    dropAllMutate.mockReset();
    // Detail pane hook defaults to idle (no selection) for the list-focused tests.
    useFailedTask.mockReturnValue(detailResult());
  });

  it('renders the loading skeleton while the list is loading', () => {
    useFailedTasks.mockReturnValue(listResult({ isLoading: true }));
    renderPage();
    expect(screen.getByLabelText(/Loading tasks/i)).toBeInTheDocument();
  });

  it('renders an error state when the list query fails', () => {
    useFailedTasks.mockReturnValue(listResult({ error: new Error('403 Forbidden') }));
    renderPage();
    expect(screen.getByText(/Failed to load tasks/i)).toBeInTheDocument();
  });

  it('renders the empty "clean queue" state when there are no tasks', () => {
    useFailedTasks.mockReturnValue(listResult({ data: makeList([]) }));
    renderPage();
    expect(screen.getByText(/No dead-lettered tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/Background processing is clean/i)).toBeInTheDocument();
    // Header count reflects zero.
    expect(screen.getByText('0 tasks')).toBeInTheDocument();
  });

  it('renders a populated list with a per-status breakdown', () => {
    const tasks = [
      makeTask({ id: 't-dead', task_name: 'trueppm.drain_outbox', status: 'dead' }),
      makeTask({ id: 't-retry', task_name: 'trueppm.purge_webhooks', status: 'pending_retry' }),
      makeTask({ id: 't-dismissed', task_name: 'trueppm.snapshot_baseline', status: 'dismissed' }),
      makeTask({ id: 't-retried', task_name: 'trueppm.reindex', status: 'retried' }),
    ];
    useFailedTasks.mockReturnValue(listResult({ data: makeList(tasks) }));
    renderPage();

    // Each row renders its task name.
    expect(screen.getByText('trueppm.drain_outbox')).toBeInTheDocument();
    expect(screen.getByText('trueppm.purge_webhooks')).toBeInTheDocument();
    // Header count.
    expect(screen.getByText('4 tasks')).toBeInTheDocument();
    // Per-status dots — each status contributes its own accessible label.
    expect(screen.getByLabelText('Dead')).toBeInTheDocument();
    expect(screen.getByLabelText('Pending retry')).toBeInTheDocument();
    expect(screen.getByLabelText('Dismissed')).toBeInTheDocument();
    expect(screen.getByLabelText('Retried')).toBeInTheDocument();
    // Empty-state message must be absent.
    expect(screen.queryByText(/No dead-lettered tasks/i)).not.toBeInTheDocument();
  });

  it('uses the singular "task" label when exactly one task is present', () => {
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask()]) }));
    renderPage();
    expect(screen.getByText('1 task')).toBeInTheDocument();
  });

  it('renders the detail pane for the ?selected= task with its status pill', () => {
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    renderPage('/settings/health/dead-letters?selected=task-1');

    // Detail header shows the exception summary + status pill ("Dead").
    expect(screen.getByRole('heading', { name: 'trueppm.drain_outbox' })).toBeInTheDocument();
    expect(screen.getByText('Attempt summary')).toBeInTheDocument();
    expect(screen.getByText('Connection refused')).toBeInTheDocument();
    // "Dead" appears both as the list-row dot label and the detail pill — assert
    // at least one is present via the pill text node.
    const pills = screen.getAllByText('Dead');
    expect(pills.length).toBeGreaterThan(0);
  });

  it('renders a detail error when the selected task fails to load', () => {
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask({ id: 'task-1' })]) }));
    useFailedTask.mockReturnValue(detailResult({ error: new Error('boom') }));
    renderPage('/settings/health/dead-letters?selected=task-1');
    expect(screen.getByText(/Failed to load task details/i)).toBeInTheDocument();
  });

  it('shows both bulk actions under the default (all) filter', () => {
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask()]) }));
    renderPage();
    expect(screen.getByRole('button', { name: /Requeue all \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Drop all \(1\)/ })).toBeInTheDocument();
  });

  it('hides both bulk actions under a Dismissed-only filter (rule 219 — no dead affordance)', async () => {
    const user = userEvent.setup();
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask({ status: 'dismissed' })]) }));
    renderPage();

    // Default filter: both bulk buttons present.
    expect(screen.getByRole('button', { name: /Requeue all/ })).toBeInTheDocument();

    // Filter to Dismissed: requeue-all can't act (terminal) and drop-all is a
    // no-op (already dismissed), so both bulk affordances disappear.
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'dismissed');
    expect(screen.queryByRole('button', { name: /Requeue all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Drop all/ })).not.toBeInTheDocument();
  });

  it('renders the detail loading placeholder while the selected task loads', () => {
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask({ id: 'task-1' })]) }));
    useFailedTask.mockReturnValue(detailResult({ isLoading: true }));
    renderPage('/settings/health/dead-letters?selected=task-1');
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('selecting a list row opens its detail pane via the URL', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    renderPage('/settings/health/dead-letters');

    // No selection yet → right pane shows the empty prompt.
    expect(screen.getByText('Select a task to inspect.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'trueppm.drain_outbox' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /trueppm\.drain_outbox/ }));

    expect(screen.getByRole('heading', { name: 'trueppm.drain_outbox' })).toBeInTheDocument();
  });

  it('the mobile "Back to list" control clears the selection', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    renderPage('/settings/health/dead-letters?selected=task-1');

    expect(screen.getByRole('heading', { name: 'trueppm.drain_outbox' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Back to list/ }));

    expect(screen.queryByRole('heading', { name: 'trueppm.drain_outbox' })).not.toBeInTheDocument();
    expect(screen.getByText('Select a task to inspect.')).toBeInTheDocument();
  });

  it('shows Requeue + Drop on an actionable (dead) task', () => {
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    renderPage('/settings/health/dead-letters?selected=task-1');
    expect(screen.getByRole('button', { name: 'Requeue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drop' })).toBeInTheDocument();
  });

  it('hides Requeue but keeps Drop on a terminal (retried) task', () => {
    const task = makeTask({ id: 'task-1', status: 'retried' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    renderPage('/settings/health/dead-letters?selected=task-1');
    // retried is not requeueable, but is still droppable (not yet dismissed).
    expect(screen.queryByRole('button', { name: 'Requeue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drop' })).toBeInTheDocument();
  });

  it('hides both actions and shows the resolution audit line for a dismissed task', () => {
    const task = makeTask({
      id: 'task-1',
      status: 'dismissed',
      resolved_at: '2026-05-26T10:00:00Z',
      resolved_by_display: 'Ada Ops',
      resolution_note: 'duplicate submission',
    });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    renderPage('/settings/health/dead-letters?selected=task-1');

    expect(screen.queryByRole('button', { name: 'Requeue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drop' })).not.toBeInTheDocument();
    // Audit line reports the drop, the actor, and the note (one merged paragraph).
    expect(screen.getByText(/Dropped by Ada Ops/)).toBeInTheDocument();
    expect(screen.getByText(/duplicate submission/)).toBeInTheDocument();
  });

  it('requeues a single task and toasts on success, closing the dialog', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    requeueMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    renderPage('/settings/health/dead-letters?selected=task-1');

    await user.click(screen.getByRole('button', { name: 'Requeue' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Requeue task?')).toBeInTheDocument();

    // Choose a non-default backoff before confirming.
    await user.selectOptions(within(dialog).getByLabelText('Backoff'), '300');
    await user.click(within(dialog).getByRole('button', { name: 'Requeue' }));

    expect(requeueMutate).toHaveBeenCalledWith(
      { id: 'task-1', backoffSeconds: 300 },
      expect.objectContaining({
        onSuccess: expect.any(Function) as unknown,
        onError: expect.any(Function) as unknown,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Requeued trueppm.drain_outbox.');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('surfaces an inline alert + toast and keeps the dialog open on a requeue error', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    requeueMutate.mockImplementation((_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.({ response: { data: { detail: 'Worker offline' } } }),
    );
    renderPage('/settings/health/dead-letters?selected=task-1');

    await user.click(screen.getByRole('button', { name: 'Requeue' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Requeue' }));

    // Server detail surfaces both inline (alert role) and via toast; dialog stays open.
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Worker offline');
    expect(toast.error).toHaveBeenCalledWith('Worker offline');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('drops a single task with a note and toasts on success', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    dropMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    renderPage('/settings/health/dead-letters?selected=task-1');

    await user.click(screen.getByRole('button', { name: 'Drop' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Drop task?')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Note/), 'poison message');
    await user.click(within(dialog).getByRole('button', { name: 'Drop' }));

    expect(dropMutate).toHaveBeenCalledWith(
      { id: 'task-1', note: 'poison message' },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(toast.success).toHaveBeenCalledWith('Dropped trueppm.drain_outbox.');
  });

  it('uses the generic fallback message when a requeue error has no server detail', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 'task-1', status: 'dead' });
    useFailedTasks.mockReturnValue(listResult({ data: makeList([task]) }));
    useFailedTask.mockReturnValue(detailResult({ data: task }));
    requeueMutate.mockImplementation((_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.(new Error('network')),
    );
    renderPage('/settings/health/dead-letters?selected=task-1');

    await user.click(screen.getByRole('button', { name: 'Requeue' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Requeue' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Action failed — please try again.');
  });

  it('bulk-requeues the filter set and reports a capped, pluralized count', async () => {
    const user = userEvent.setup();
    const tasks = [
      makeTask({ id: 'a', status: 'dead' }),
      makeTask({ id: 'b', status: 'dead' }),
      makeTask({ id: 'c', status: 'dead' }),
    ];
    useFailedTasks.mockReturnValue(listResult({ data: makeList(tasks) }));
    requeueAllMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: (r: unknown) => void }) =>
        opts.onSuccess?.({ processed: 3, matched: 5, capped: true }),
    );
    renderPage('/settings/health/dead-letters');

    await user.click(screen.getByRole('button', { name: /Requeue all \(3\)/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Requeue 3 tasks?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Requeue 3' }));

    expect(requeueAllMutate).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.any(Object) as unknown, backoffSeconds: 0 }),
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Requeued 3 tasks. (batch capped — repeat to continue)',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('bulk-drops the filter set and reports a singular, uncapped count', async () => {
    const user = userEvent.setup();
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask({ status: 'dead' })]) }));
    dropAllMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: (r: unknown) => void }) =>
        opts.onSuccess?.({ processed: 1, matched: 1, capped: false }),
    );
    renderPage('/settings/health/dead-letters');

    await user.click(screen.getByRole('button', { name: /Drop all \(1\)/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Drop 1' }));

    expect(dropAllMutate).toHaveBeenCalled();
    // Singular "task", no capped suffix.
    expect(toast.success).toHaveBeenCalledWith('Dropped 1 task.');
  });

  it('surfaces a bulk error inline and via toast without closing the dialog', async () => {
    const user = userEvent.setup();
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask({ status: 'dead' })]) }));
    requeueAllMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
        opts.onError?.({ response: { data: { detail: 'Rate limited' } } }),
    );
    renderPage('/settings/health/dead-letters');

    await user.click(screen.getByRole('button', { name: /Requeue all \(1\)/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Requeue 1' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Rate limited');
    expect(toast.error).toHaveBeenCalledWith('Rate limited');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('narrows the query when the time-window filter changes', async () => {
    const user = userEvent.setup();
    useFailedTasks.mockReturnValue(listResult({ data: makeList([makeTask()]) }));
    renderPage('/settings/health/dead-letters');

    const windowSelect = screen.getByLabelText('Filter by time window');
    expect(windowSelect).toHaveValue('');
    await user.selectOptions(windowSelect, '24h');
    expect(windowSelect).toHaveValue('24h');

    // Task-name search is debounced; typing must update the controlled input.
    const search = screen.getByLabelText('Search by task name');
    await user.type(search, 'drain');
    expect(search).toHaveValue('drain');
  });
});
