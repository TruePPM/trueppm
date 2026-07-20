import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { Task } from '@/types';
import type { ProgramTaskResult } from '@/features/programs/hooks/useProgramTaskSearch';
import { RelatedLinkPicker } from './RelatedLinkPicker';

// mutate() invokes onSuccess synchronously (or onError when `relState.fail` is
// set) so the close-vs-error branch of submit() is deterministic in tests.
const { mutateSpy, refetchSpy, searchState } = vi.hoisted(() => ({
  mutateSpy: vi.fn(
    (
      _payload: unknown,
      opts?: { onSuccess?: (data: unknown) => void; onError?: (e: unknown) => void },
    ) => {
      if ((globalThis as Record<string, unknown>).__relFail) {
        opts?.onError?.(new Error('boom'));
      } else {
        opts?.onSuccess?.({});
      }
    },
  ),
  refetchSpy: vi.fn(),
  searchState: { data: [] as ProgramTaskResult[], isLoading: false, isError: false },
}));

vi.mock('@/hooks/useTaskRelations', () => ({
  useCreateTaskRelation: () => ({ mutate: mutateSpy, isPending: false }),
}));

vi.mock('@/features/programs/hooks/useProgramTaskSearch', () => ({
  useProgramTaskSearch: () => ({
    data: searchState.data,
    isLoading: searchState.isLoading,
    isError: searchState.isError,
    refetch: refetchSpy,
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-source',
    wbs: '1',
    name: 'Source task',
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    readiness: 'ready',
    assignees: [],
    notes: '',
    totalFloat: 3,
    ...overrides,
  } as Task;
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const LOCAL_TASKS: Task[] = [
  makeTask({ id: 't-local-1', name: 'Design review', wbs: '1.1', shortId: 'ABC123' }),
  makeTask({ id: 't-local-2', name: 'Build feature', wbs: '1.2', shortId: undefined }),
];

const CROSS_ROWS: ProgramTaskResult[] = [
  { id: 'x1', name: 'Security sign-off', short_id: 'SEC-3', project_id: 'p-sec', project_name: 'Security' },
  { id: 'x2', name: 'Security review', short_id: 'SEC-8', project_id: 'p-sec', project_name: 'Security' },
  { id: 'x3', name: 'Legal go-ahead', short_id: 'LEG-1', project_id: 'p-leg', project_name: 'Legal' },
];

beforeEach(() => {
  vi.clearAllMocks();
  searchState.data = [];
  searchState.isLoading = false;
  searchState.isError = false;
  (globalThis as Record<string, unknown>).__relFail = false;
});

describe('RelatedLinkPicker — single-project scope', () => {
  it('hides the scope toggle and defaults to This-project results for a standalone project', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'Program' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Build feature/ })).toBeInTheDocument();
    // Standalone footer omits the scope hint.
    expect(screen.getByText('↑↓ navigate · Enter add · Esc cancel')).toBeInTheDocument();
  });

  it('excludes the source task itself and any excludedIds from the results', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask({ id: 't-local-1', name: 'Design review' })}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set(['t-local-2'])}
        onClose={vi.fn()}
      />,
    );
    // Source (Design review) excluded as self; Build feature excluded via excludedIds.
    const listbox = screen.getByRole('listbox', { name: 'Task results' });
    expect(within(listbox).queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText(/No matching tasks\. Try a different search\./)).toBeInTheDocument();
  });

  it('filters by task name and by WBS code', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Search tasks');
    fireEvent.change(input, { target: { value: 'design' } });
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Build feature/ })).not.toBeInTheDocument();

    // WBS match: '1.2' belongs only to Build feature.
    fireEvent.change(input, { target: { value: '1.2' } });
    expect(screen.getByRole('option', { name: /Build feature/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Design review/ })).not.toBeInTheDocument();
  });

  it('renders the shortId hex, falling back to wbs then an em-dash', () => {
    const tasks: Task[] = [
      makeTask({ id: 'a', name: 'Has short id', shortId: 'HEX0001', wbs: '2' }),
      makeTask({ id: 'b', name: 'Wbs fallback', shortId: undefined, wbs: '3.4' }),
    ];
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={tasks}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('option', { name: /Has short id/ })).toHaveTextContent('HEX0001');
    expect(screen.getByRole('option', { name: /Wbs fallback/ })).toHaveTextContent('3.4');
  });

  it('caps the result list at 12 rows', () => {
    const many: Task[] = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `m-${i}`, name: `Match ${i}`, wbs: `9.${i}` }),
    );
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={many}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    const listbox = screen.getByRole('listbox', { name: 'Task results' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(12);
  });
});

describe('RelatedLinkPicker — relation type + submit', () => {
  it('creates the relation with the default relates_to type and closes on success', () => {
    const onClose = vi.fn();
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(mutateSpy).toHaveBeenCalledWith(
      { source: 't-source', target: 't-local-1', relation_type: 'relates_to' },
      expect.any(Object),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honors the selected relation type in the created payload', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    // Forward labels drive the select options.
    const select = screen.getByLabelText('Relation');
    expect(within(select).getByRole('option', { name: 'Relates to' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Blocks' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Duplicates' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'blocks' } });
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ relation_type: 'blocks', target: 't-local-1' }),
      expect.any(Object),
    );
  });

  it('surfaces an inline error and keeps the dialog open when the mutation fails', () => {
    (globalThis as Record<string, unknown>).__relFail = true;
    const onClose = vi.fn();
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(onClose).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Couldn.t link task\. Try again\./);
  });

  it('clears the inline error when the search term changes', () => {
    (globalThis as Record<string, unknown>).__relFail = true;
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'x' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('RelatedLinkPicker — program scope (cross-project)', () => {
  it('shows the scope toggle and opens on the Program tab when there is a program', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'This project' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Program', selected: true })).toBeInTheDocument();
    // Program-scope placeholder + no-query hint.
    expect(screen.getByPlaceholderText('Search tasks in this program…')).toBeInTheDocument();
    expect(
      screen.getByText(/Search for a task in another project of this program to link\./),
    ).toBeInTheDocument();
    // Footer carries the scope hint when cross-project is available.
    expect(screen.getByText('←→ scope · ↑↓ navigate · Enter add · Esc cancel')).toBeInTheDocument();
  });

  it('groups program search results by project once the debounce settles', async () => {
    searchState.data = CROSS_ROWS;
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    const list = await screen.findByRole('listbox', { name: 'Program task results' });
    // Project names render as group headers (and again in each row's right column).
    expect(within(list).getAllByText('Security').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Legal').length).toBeGreaterThan(0);
    expect(within(list).getByRole('option', { name: /Security sign-off/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Legal go-ahead/ })).toBeInTheDocument();
  });

  it('submits a cross-project relation with the picked target', async () => {
    searchState.data = CROSS_ROWS;
    const onClose = vi.fn();
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    fireEvent.click(await screen.findByRole('button', { name: /Security sign-off/ }));
    expect(mutateSpy).toHaveBeenCalledWith(
      { source: 't-source', target: 'x1', relation_type: 'relates_to' },
      expect.any(Object),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('excludes already-related and self ids from grouped program results', async () => {
    searchState.data = CROSS_ROWS;
    wrap(
      <RelatedLinkPicker
        task={makeTask({ id: 'x2' })}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set(['x3'])}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    await screen.findByRole('option', { name: /Security sign-off/ });
    // x2 is the source (self), x3 is excluded → only x1 remains, and its Legal group is gone.
    expect(screen.queryByRole('option', { name: /Security review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Legal go-ahead/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Legal')).not.toBeInTheDocument();
  });

  it('renders the loading skeleton while the program query is in flight', async () => {
    searchState.isLoading = true;
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    expect(await screen.findByLabelText('Loading tasks')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an error state with a working Retry button', async () => {
    searchState.isError = true;
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    expect(await screen.findByText(/Couldn.t load program tasks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shows the program empty-state when the search returns nothing', async () => {
    searchState.data = [];
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'zzz' } });
    expect(
      await screen.findByText(/No matching tasks in this program\. Try a different search\./),
    ).toBeInTheDocument();
  });

  it('switches back to This-project scope via the tab', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'This project' }));
    expect(screen.getByRole('tab', { name: 'This project', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks…')).toBeInTheDocument();
  });
});

describe('RelatedLinkPicker — keyboard interaction', () => {
  it('moves the active row with ArrowDown/ArrowUp and adds with Enter', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    // First row active by default.
    expect(screen.getByRole('option', { name: /Design review/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Build feature/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Design review/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ target: 't-local-1' }),
      expect.any(Object),
    );
  });

  it('switches scope with ArrowLeft/ArrowRight when cross-project is available', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'This project', selected: true })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Program', selected: true })).toBeInTheDocument();
  });

  it('does not switch scope with arrows for a standalone project', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    // Still project scope — no Program tab exists and local options remain.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
  });
});

describe('RelatedLinkPicker — dialog chrome', () => {
  it('focuses the search input on open and titles the dialog with the task name', () => {
    wrap(
      <RelatedLinkPicker
        task={makeTask({ name: 'Ship it' })}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Search tasks'));
    expect(screen.getByRole('dialog', { name: /Link a task to .Ship it./ })).toBeInTheDocument();
  });

  it('closes via the scrim, the header close button, and Escape', () => {
    const onClose = vi.fn();
    wrap(
      <RelatedLinkPicker
        task={makeTask()}
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
