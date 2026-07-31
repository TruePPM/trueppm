import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { Task } from '@/types';
import type { ProgramTaskResult } from '@/features/programs/hooks/useProgramTaskSearch';
import {
  ScheduleDependencyPicker,
  type ScheduleDependencyPickerProps,
} from './ScheduleDependencyPicker';

// mutate() invokes onSuccess synchronously with the response so the consent
// toast branch (pending vs accepted) is deterministic. `response` is mutated
// per-test to simulate the ADR-0120 D2 consent outcome.
const { mutateSpy, infoSpy, successSpy, errorSpy, searchState, refetchSpy, mutateOutcome } =
  vi.hoisted(() => {
    const outcome: { error: unknown } = { error: null };
    return {
      mutateSpy: vi.fn(
        (
          _payload: unknown,
          opts?: { onSuccess?: (data: unknown) => void; onError?: (e: unknown) => void },
        ) => {
          if (outcome.error !== null) {
            opts?.onError?.(outcome.error);
            return;
          }
          opts?.onSuccess?.((globalThis as Record<string, unknown>).__depResponse);
        },
      ),
      infoSpy: vi.fn(),
      successSpy: vi.fn(),
      errorSpy: vi.fn(),
      refetchSpy: vi.fn(),
      searchState: {
        // `undefined` mirrors an unresolved/failed query — the real hook only
        // yields an array once a request succeeds.
        data: undefined as ProgramTaskResult[] | undefined,
        isLoading: false,
        isError: false,
      },
      mutateOutcome: outcome,
    };
  });

vi.mock('@/components/Toast', () => ({
  toast: { info: infoSpy, success: successSpy, error: errorSpy, warm: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/hooks/useTaskMutations', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useTaskMutations')>()),
  useAddDependency: () => ({ mutate: mutateSpy, isPending: false }),
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
  };
}

function setResponse(r: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).__depResponse = r;
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const LOCAL_TASKS: Task[] = [
  makeTask({ id: 't-local-1', name: 'Design review', wbs: '1.1' }),
  makeTask({ id: 't-local-2', name: 'Build feature', wbs: '1.2' }),
];

// short_id is real 8-hex-digit (never a pretty fake like the old 'SEC-3') —
// that shape is exactly what hid the #2671 raw-hex leak on this endpoint's
// results. qualified_id/short_id_display are what a real (fixed) API response
// carries and what the picker must render instead of short_id.
const CROSS_ROWS: ProgramTaskResult[] = [
  {
    id: 'x1',
    name: 'Security sign-off',
    short_id: '00000003',
    short_id_display: 'T-3',
    qualified_id: 'SEC-3',
    project_id: 'p-sec',
    project_name: 'Security',
  },
  {
    id: 'x2',
    name: 'Security review',
    short_id: '00000008',
    short_id_display: 'T-8',
    qualified_id: 'SEC-8',
    project_id: 'p-sec',
    project_name: 'Security',
  },
  {
    id: 'x3',
    name: 'Legal go-ahead',
    short_id: '00000001',
    short_id_display: 'T-1',
    qualified_id: 'LEG-1',
    project_id: 'p-leg',
    project_name: 'Legal',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  searchState.data = undefined;
  searchState.isLoading = false;
  searchState.isError = false;
  mutateOutcome.error = null;
  setResponse({});
});

/** Render the picker with sane defaults; every prop is overridable per test. */
function renderPicker(props: Partial<ScheduleDependencyPickerProps> = {}) {
  const merged: ScheduleDependencyPickerProps = {
    task: makeTask(),
    mode: 'predecessor',
    projectId: 'p1',
    programId: null,
    allTasks: LOCAL_TASKS,
    excludedIds: new Set<string>(),
    onClose: vi.fn(),
    ...props,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <ScheduleDependencyPicker {...merged} />
    </QueryClientProvider>,
  );
  return {
    ...result,
    props: merged,
    /** Re-render in place (same QueryClient) with a subset of props swapped. */
    rerenderWith(next: Partial<ScheduleDependencyPickerProps>) {
      result.rerender(
        <QueryClientProvider client={qc}>
          <ScheduleDependencyPicker {...merged} {...next} />
        </QueryClientProvider>,
      );
    },
  };
}

/** Accessible names of the currently-rendered option rows, in list order. */
function optionNames(): string[] {
  return screen
    .queryAllByRole('option')
    .map((o) => o.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

/** Index of the option row currently marked `aria-selected`. */
function selectedIndex(): number {
  return screen.queryAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
}

describe('ScheduleDependencyPicker — single-project (no regression)', () => {
  it('hides the scope toggle when the project has no program', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'Program' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
  });

  it('adds a same-project predecessor without a toast (silent close)', () => {
    const onClose = vi.fn();
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-local-1', successor: 't-source' },
      expect.any(Object),
    );
    expect(infoSpy).not.toHaveBeenCalled();
    expect(successSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // Rule 228 / WCAG 2.5.5 (#1801): each option row (the touch alternative to
  // canvas drag-to-link, rule 230) keeps a 44px hit height on phones and only
  // compacts to 36px at `md:`. Regression guarded: compaction keyed off `sm:`
  // (fires at 375px) dropped the row to 36px on every phone.
  it('option rows keep a 44px touch height, compacting only at md:', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    const cls = screen.getByRole('button', { name: /Design review/ }).className;
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('md:h-9');
    expect(cls).not.toContain('sm:h-9');
  });
});

describe('ScheduleDependencyPicker — cross-project (ADR-0120)', () => {
  it('shows the scope toggle when the project belongs to a program', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="successor"
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'This project' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Program' })).toBeInTheDocument();
  });

  it('groups program results by project name', async () => {
    searchState.data = CROSS_ROWS;
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="successor"
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });

    // Results appear after the 200ms search debounce settles.
    const list = await screen.findByRole('listbox', { name: 'Program task results' });
    expect(within(list).getByText('Security')).toBeInTheDocument();
    expect(within(list).getByText('Legal')).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Security sign-off/ })).toBeInTheDocument();
  });

  it('fires an accepted toast when the edge is created modeled', async () => {
    searchState.data = CROSS_ROWS;
    setResponse({ pending_acceptance: false });
    const onClose = vi.fn();
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="successor"
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    fireEvent.click(await screen.findByRole('button', { name: /Security sign-off/ }));

    // successor mode: source → picked
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-source', successor: 'x1' },
      expect.any(Object),
    );
    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining('Security'));
    expect(infoSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('fires a pending-consent toast when the edge is created inert', async () => {
    searchState.data = CROSS_ROWS;
    setResponse({ pending_acceptance: true });
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="successor"
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'leg' } });
    fireEvent.click(await screen.findByRole('button', { name: /Legal go-ahead/ }));

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Legal'));
    expect(successSpy).not.toHaveBeenCalled();
  });

  it('lands on Program scope when opened with initialScope="program" (drawer entry point)', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        initialScope="program"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Program', selected: true })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks in this program…')).toBeInTheDocument();
  });

  it('ignores initialScope="program" for a standalone project (no program to search)', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        initialScope="program"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'Program' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
  });

  it('shows an empty-state message when the program search returns nothing', async () => {
    searchState.data = [];
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="successor"
        projectId="p1"
        programId="prog-1"
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'zzz' } });
    expect(await screen.findByText(/No matching tasks in this program/)).toBeInTheDocument();
  });
});

describe('ScheduleDependencyPicker — focus trap (#1637, web-rule 206)', () => {
  it('moves focus to the search input on open', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Search tasks'));
  });

  it('closes on Escape (routed through the trap, not lost to stopPropagation)', () => {
    const onClose = vi.fn();
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Shift+Tab from the first focusable back to the last (trap engaged)', () => {
    wrap(
      <ScheduleDependencyPicker
        task={makeTask()}
        mode="predecessor"
        projectId="p1"
        programId={null}
        allTasks={LOCAL_TASKS}
        excludedIds={new Set()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const focusables = within(dialog).getAllByRole('button');
    const first = focusables[0];
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    // Focus wrapped to the last focusable inside the dialog rather than
    // escaping to the (non-modal) surface behind the scrim.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(first);
  });
});

describe('ScheduleDependencyPicker — project-scope filtering', () => {
  it('never offers the source task itself as a dependency counterpart', () => {
    const source = makeTask();
    renderPicker({ task: source, allTasks: [source, ...LOCAL_TASKS] });
    expect(optionNames()).toHaveLength(2);
    expect(screen.queryByRole('option', { name: /Source task/ })).not.toBeInTheDocument();
  });

  it('hides tasks already linked in this mode', () => {
    renderPicker({ excludedIds: new Set(['t-local-1']) });
    expect(screen.queryByRole('option', { name: /Design review/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Build feature/ })).toBeInTheDocument();
  });

  it('matches on task name, case-insensitively', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'DESIGN' } });
    expect(optionNames()).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
  });

  it('matches on WBS code even when the name does not contain the term', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: '1.2' } });
    expect(optionNames()).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Build feature/ })).toBeInTheDocument();
  });

  it('shows the project-scope empty state when nothing matches', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'nope' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No matching tasks\. Try a different search\./)).toBeInTheDocument();
  });

  it('caps the result list at 12 rows', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t-${i}`, name: `Task ${i}`, wbs: `2.${i}` }),
    );
    renderPicker({ allTasks: many });
    expect(screen.getAllByRole('option')).toHaveLength(12);
  });

  it('falls back to an em dash when a task has no WBS code', () => {
    renderPicker({ allTasks: [makeTask({ id: 't-nowbs', name: 'Unnumbered', wbs: '' })] });
    expect(screen.getByRole('button', { name: /Unnumbered/ })).toHaveTextContent('—');
  });

  it('renders a humanized status chip for a normal task', () => {
    renderPicker({
      allTasks: [makeTask({ id: 't-ip', name: 'Wiring', wbs: '3.1', status: 'IN_PROGRESS' })],
    });
    expect(screen.getByRole('button', { name: /Wiring/ })).toHaveTextContent('in progress');
  });

  it('renders a milestone marker instead of a status chip for a milestone', () => {
    renderPicker({
      allTasks: [
        makeTask({ id: 't-ms', name: 'Go live', wbs: '4', isMilestone: true, status: 'NOT_STARTED' }),
      ],
    });
    const row = screen.getByRole('button', { name: /Go live/ });
    expect(row).toHaveTextContent('— milestone');
    expect(row).not.toHaveTextContent('not started');
  });
});

describe('ScheduleDependencyPicker — keyboard navigation', () => {
  it('moves the active row down and up with the arrow keys', () => {
    renderPicker();
    expect(selectedIndex()).toBe(0);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(selectedIndex()).toBe(1);

    // Already on the last row — ArrowDown clamps rather than wrapping.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(selectedIndex()).toBe(1);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(selectedIndex()).toBe(0);

    // Already on the first row — ArrowUp clamps at 0.
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(selectedIndex()).toBe(0);
  });

  it('adds the active row on Enter', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-local-2', successor: 't-source' },
      expect.any(Object),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter is inert when the result list is empty', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'nope' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('switches scope with ← and → when the project belongs to a program', () => {
    renderPicker({ programId: 'prog-1' });
    expect(screen.getByRole('tab', { name: 'This project', selected: true })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Program', selected: true })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks in this program…')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'This project', selected: true })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks…')).toBeInTheDocument();
  });

  it('ignores ← and → for a standalone project (no program scope to reach)', () => {
    renderPicker({ programId: null });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    // Still the local list, still the single-project placeholder.
    expect(screen.getByPlaceholderText('Search tasks…')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
  });

  it('clamps the active row when the list shrinks underneath it', () => {
    const view = renderPicker();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(selectedIndex()).toBe(1);

    // The schedule dropped a task while the picker was open.
    view.rerenderWith({ allTasks: [LOCAL_TASKS[0]] });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(selectedIndex()).toBe(0);
  });

  it('hovering a row makes it the active row', () => {
    renderPicker();
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Build feature/ }));
    expect(selectedIndex()).toBe(1);
  });

  it('shows the scope hint in the footer only when a program scope exists', () => {
    const { unmount } = renderPicker({ programId: 'prog-1' });
    expect(screen.getByText(/←→ scope/)).toBeInTheDocument();
    unmount();

    renderPicker({ programId: null });
    expect(screen.queryByText(/←→ scope/)).not.toBeInTheDocument();
    expect(screen.getByText(/↑↓ navigate · Enter add · Esc cancel/)).toBeInTheDocument();
  });
});

describe('ScheduleDependencyPicker — failure surfaces', () => {
  const CYCLE_ERROR = {
    response: {
      data: {
        detail: 'cyclic_dependency',
        cycle: [
          { id: 'a', name: 'Design review', hex_id: 'AAA' },
          { id: 'b', name: 'Source task', hex_id: 'BBB' },
        ],
      },
    },
  };

  it('surfaces the server cycle path inline and keeps the modal open', () => {
    mutateOutcome.error = CYCLE_ERROR;
    const onClose = vi.fn();
    renderPicker({ onClose });

    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /circular dependency: Design review → Source task/,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('falls back to a generic retry message for a non-cycle failure', () => {
    mutateOutcome.error = new Error('network down');
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to add dependency. Retry?');
  });

  it('clears the inline error as soon as the user edits the search term', () => {
    mutateOutcome.error = new Error('network down');
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'b' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the inline error when the user switches scope', () => {
    mutateOutcome.error = new Error('network down');
    renderPicker({ programId: 'prog-1' });
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retrying a failed add succeeds and closes once the server accepts it', () => {
    mutateOutcome.error = new Error('network down');
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    mutateOutcome.error = null;
    fireEvent.click(screen.getByRole('button', { name: /Design review/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleDependencyPicker — program-scope states', () => {
  it('prompts for a search term before any program request is made', () => {
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    expect(
      screen.getByText(/Search for a task in another project of this program to depend on\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Program task results' })).not.toBeInTheDocument();
  });

  it('shows a busy placeholder while the program search is in flight', async () => {
    searchState.isLoading = true;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });
    expect(await screen.findByLabelText('Loading tasks')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers a retry when the program search fails', async () => {
    searchState.isError = true;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/Couldn’t load program tasks\./)).toBeInTheDocument();
    fireEvent.click(retry);
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it('renders a cross-project row\'s server-decoded reference, never its raw hex short_id (#2671)', async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });

    const row = await screen.findByRole('button', { name: /Security sign-off/ });
    // qualified_id ("SEC-3") is what cross-project rows must render — it is
    // the one #2671 site where the project-code prefix disambiguates two
    // sibling projects' task 3 from each other.
    expect(row).toHaveTextContent('SEC-3');
    expect(row).not.toHaveTextContent('00000003');
  });

  it('drops the source task and already-linked tasks from the program results', async () => {
    searchState.data = [
      { id: 't-source', name: 'Source task', short_id: 'SRC-1', project_id: 'p1', project_name: 'Mine' },
      ...CROSS_ROWS,
    ];
    renderPicker({
      programId: 'prog-1',
      initialScope: 'program',
      excludedIds: new Set(['x1']),
    });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'e' } });

    await screen.findByRole('listbox', { name: 'Program task results' });
    expect(screen.queryByRole('option', { name: /Source task/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Security sign-off/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Security review/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Legal go-ahead/ })).toBeInTheDocument();
  });

  it('falls back to an em dash when a program result has no short id', async () => {
    searchState.data = [
      { id: 'x9', name: 'Unlabeled work', short_id: '', project_id: 'p-z', project_name: 'Zeta' },
    ];
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'un' } });

    const row = await screen.findByRole('button', { name: /Unlabeled work/ });
    expect(row).toHaveTextContent('—');
    // Cross-project rows carry no status chip — the sibling project owns status.
    expect(row).not.toHaveTextContent('not started');
  });

  it('hovering a grouped program row makes it the active row across groups', async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'e' } });

    await screen.findByRole('listbox', { name: 'Program task results' });
    // "Legal go-ahead" is the third flat row (second group) — hovering it must
    // select index 2, proving the group→flat index mapping.
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Legal go-ahead/ }));
    expect(selectedIndex()).toBe(2);
  });

  it('Enter adds the active cross-project row', async () => {
    searchState.data = CROSS_ROWS;
    setResponse({ pending_acceptance: false });
    renderPicker({ programId: 'prog-1', initialScope: 'program', mode: 'predecessor' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'e' } });
    await screen.findByRole('listbox', { name: 'Program task results' });

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 'x2', successor: 't-source' },
      expect.any(Object),
    );
  });
});

describe('ScheduleDependencyPicker — dismissal affordances', () => {
  it('closes on the header close button', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels the dialog for the successor mode', () => {
    renderPicker({ mode: 'successor', task: makeTask({ name: 'Cutover' }) });
    expect(screen.getByRole('dialog', { name: 'Add successor to “Cutover”' })).toBeInTheDocument();
  });
});

describe('ScheduleDependencyPicker — scope tabs', () => {
  it('returns to the local list when the "This project" tab is clicked', async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'e' } });
    await screen.findByRole('listbox', { name: 'Program task results' });

    fireEvent.click(screen.getByRole('tab', { name: 'This project' }));
    expect(screen.getByRole('listbox', { name: 'Task results' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Program task results' })).not.toBeInTheDocument();
    // Scope change resets the highlight to the first local row.
    expect(selectedIndex()).toBe(0);
  });
});
