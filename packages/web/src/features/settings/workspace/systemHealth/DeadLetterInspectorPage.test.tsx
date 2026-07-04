/**
 * DeadLetterInspectorPage — component unit tests.
 *
 * Exercises the split-view list branches over a mocked useFailedTasks: loading
 * skeleton, hard error, empty "clean queue" state, a populated list with a
 * per-status breakdown (each FailedTaskStatus renders its own dot + label), and
 * the detail pane driven by ?selected= over a mocked useFailedTask. Fixtures use
 * the REAL FailedTask / PaginatedResponse shape — no invented keys.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterInspectorPage } from './DeadLetterInspectorPage';
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
});
