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

/**
 * The result rows, scoped to the listbox.
 *
 * NOT `rowOptions()`. Since #3023 the dialog also contains a
 * link-type `<select>`, and a native `<option>` carries the implicit role
 * `option` too — so an unscoped query returns four extra elements that are not
 * rows, and every count and index in this file silently shifts. The `<select>`
 * itself is a `combobox`, never a `listbox`, so scoping here is unambiguous.
 */
function rowOptions(): HTMLElement[] {
  const listbox = screen.queryByRole('listbox');
  return listbox ? within(listbox).queryAllByRole('option') : [];
}

/** Accessible names of the currently-rendered option rows, in list order. */
function optionNames(): string[] {
  return rowOptions().map((o) => o.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

/** Index of the option row currently marked `aria-selected`. */
function selectedIndex(): number {
  return rowOptions().findIndex((o) => o.getAttribute('aria-selected') === 'true');
}

function searchInput(): HTMLElement {
  return screen.getByLabelText('Search tasks');
}

/**
 * The option element the search field's `aria-activedescendant` points at, or
 * `null` when the caret still owns the keyboard.
 *
 * Resolved through the DOM rather than compared to a computed id string on
 * purpose: a dangling `aria-activedescendant` (pointing at an id nothing renders)
 * is exactly as broken as a missing one, and only a lookup can tell them apart.
 */
function activeDescendantOption(): HTMLElement | null {
  const id = searchInput().getAttribute('aria-activedescendant');
  if (id === null) return null;
  return document.getElementById(id);
}

/**
 * Press a key the way a browser does: from the focused search input, bubbling up
 * to the window listener.
 *
 * Dispatching on `window` directly sets `e.target` to the window, which is a
 * state no real keystroke produces here — and both Space and Enter are guarded
 * on the target so a Tabbed-to button keeps its native activation. A test that
 * bypasses that guard cannot see it break.
 */
function pressKey(key: string) {
  fireEvent.keyDown(searchInput(), { key });
}

/** The text a row's `<mark>` elements carry, in order. */
function markedText(row: HTMLElement): string[] {
  return [...row.querySelectorAll('mark')].map((m) => m.textContent ?? '');
}

/**
 * Assert that Space is still a character, not a command.
 *
 * `fireEvent.keyDown` never mutates an input's value, so "Space typed" cannot be
 * observed from the field. What it CAN prove is that the picker did not treat the
 * key as a commit — the failure this guards is a Space that adds a dependency
 * while the user is composing a two-word query.
 */
function expectSpaceTypes() {
  mutateSpy.mockClear();
  fireEvent.keyDown(searchInput(), { key: ' ' });
  expect(mutateSpy).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-local-1', successor: 't-source', dep_type: 'FS', lag: 0 },
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
    const cls = screen.getByRole('option', { name: /Design review/ }).className;
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
    fireEvent.click(await screen.findByRole('option', { name: /Security sign-off/ }));

    // successor mode: source → picked
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-source', successor: 'x1', dep_type: 'FS', lag: 0 },
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
    fireEvent.click(await screen.findByRole('option', { name: /Legal go-ahead/ }));

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
    expect(rowOptions()).toHaveLength(0);
    expect(screen.getByText(/No matching tasks\. Try a different search\./)).toBeInTheDocument();
  });

  it('caps the result list at 12 rows', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t-${i}`, name: `Task ${i}`, wbs: `2.${i}` }),
    );
    renderPicker({ allTasks: many });
    expect(rowOptions()).toHaveLength(12);
  });

  it('falls back to an em dash when a task has no WBS code', () => {
    renderPicker({ allTasks: [makeTask({ id: 't-nowbs', name: 'Unnumbered', wbs: '' })] });
    expect(screen.getByRole('option', { name: /Unnumbered/ })).toHaveTextContent('—');
  });

  it('renders a humanized status chip for a normal task', () => {
    renderPicker({
      allTasks: [makeTask({ id: 't-ip', name: 'Wiring', wbs: '3.1', status: 'IN_PROGRESS' })],
    });
    expect(screen.getByRole('option', { name: /Wiring/ })).toHaveTextContent('in progress');
  });

  it('renders a milestone marker instead of a status chip for a milestone', () => {
    renderPicker({
      allTasks: [
        makeTask({
          id: 't-ms',
          name: 'Go live',
          wbs: '4',
          isMilestone: true,
          status: 'NOT_STARTED',
        }),
      ],
    });
    const row = screen.getByRole('option', { name: /Go live/ });
    expect(row).toHaveTextContent('— milestone');
    expect(row).not.toHaveTextContent('not started');
  });
});

describe('ScheduleDependencyPicker — keyboard navigation', () => {
  it('lands the FIRST ArrowDown on the FIRST row, then walks down (#3024)', () => {
    renderPicker();
    // Row 0 carries the resting highlight so `Enter` can take a sole match with
    // no keypresses — but the first ↓ must ENTER the list on that row, not step
    // past it. The shipped picker advanced unconditionally and skipped row 1.
    expect(selectedIndex()).toBe(0);

    pressKey('ArrowDown');
    expect(selectedIndex()).toBe(0);
    expect(activeDescendantOption()).toBe(rowOptions()[0]);

    pressKey('ArrowDown');
    expect(selectedIndex()).toBe(1);

    // Already on the last row — ArrowDown clamps rather than wrapping.
    pressKey('ArrowDown');
    expect(selectedIndex()).toBe(1);

    pressKey('ArrowUp');
    expect(selectedIndex()).toBe(0);
  });

  it('ArrowUp off the first row steps back OUT to the search field', () => {
    renderPicker();
    pressKey('ArrowDown');
    expect(searchInput()).toHaveAttribute('aria-activedescendant');

    pressKey('ArrowUp');
    // The visual highlight stays on row 0, but the caret owns the keyboard
    // again — which is what makes Space typable without reaching for the mouse.
    expect(selectedIndex()).toBe(0);
    expect(searchInput()).not.toHaveAttribute('aria-activedescendant');
    expectSpaceTypes();
  });

  it('adds the active row on Enter', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('Enter');
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-local-2', successor: 't-source', dep_type: 'FS', lag: 0 },
      expect.any(Object),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter is inert when the result list is empty', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'nope' } });
    pressKey('Enter');
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('switches scope with ← and → when the project belongs to a program', () => {
    renderPicker({ programId: 'prog-1' });
    expect(screen.getByRole('tab', { name: 'This project', selected: true })).toBeInTheDocument();

    pressKey('ArrowRight');
    expect(screen.getByRole('tab', { name: 'Program', selected: true })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks in this program…')).toBeInTheDocument();

    pressKey('ArrowLeft');
    expect(screen.getByRole('tab', { name: 'This project', selected: true })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks…')).toBeInTheDocument();
  });

  it('ignores ← and → for a standalone project (no program scope to reach)', () => {
    renderPicker({ programId: null });
    pressKey('ArrowRight');
    pressKey('ArrowLeft');
    // Still the local list, still the single-project placeholder.
    expect(screen.getByPlaceholderText('Search tasks…')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Design review/ })).toBeInTheDocument();
  });

  it('clamps the active row when the list shrinks underneath it', () => {
    const view = renderPicker();
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    expect(selectedIndex()).toBe(1);

    // The schedule dropped a task while the picker was open.
    view.rerenderWith({ allTasks: [LOCAL_TASKS[0]] });
    expect(rowOptions()).toHaveLength(1);
    expect(selectedIndex()).toBe(0);
  });

  it('hovering a row makes it the active row', () => {
    renderPicker();
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Build feature/ }));
    expect(selectedIndex()).toBe(1);
  });

  it('shows the scope hint in the footer only when a program scope exists', () => {
    const { unmount } = renderPicker({ programId: 'prog-1' });
    expect(screen.getByText(/←→ scope/)).toBeInTheDocument();
    unmount();

    renderPicker({ programId: null });
    expect(screen.queryByText(/←→ scope/)).not.toBeInTheDocument();
    expect(screen.getByText('↓ into list · Enter add & close · Esc cancel')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /circular dependency: Design review → Source task/,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('falls back to a generic retry message for a non-cycle failure', () => {
    mutateOutcome.error = new Error('network down');
    renderPicker();
    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to add dependency. Retry?');
  });

  it('clears the inline error as soon as the user edits the search term', () => {
    mutateOutcome.error = new Error('network down');
    renderPicker();
    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'b' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the inline error when the user switches scope', () => {
    mutateOutcome.error = new Error('network down');
    renderPicker({ programId: 'prog-1' });
    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retrying a failed add succeeds and closes once the server accepts it', () => {
    mutateOutcome.error = new Error('network down');
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    mutateOutcome.error = null;
    fireEvent.click(screen.getByRole('option', { name: /Design review/ }));
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

  it("renders a cross-project row's server-decoded reference, never its raw hex short_id (#2671)", async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'sec' } });

    const row = await screen.findByRole('option', { name: /Security sign-off/ });
    // qualified_id ("SEC-3") is what cross-project rows must render — it is
    // the one #2671 site where the project-code prefix disambiguates two
    // sibling projects' task 3 from each other.
    expect(row).toHaveTextContent('SEC-3');
    expect(row).not.toHaveTextContent('00000003');
  });

  it('drops the source task and already-linked tasks from the program results', async () => {
    searchState.data = [
      {
        id: 't-source',
        name: 'Source task',
        short_id: 'SRC-1',
        project_id: 'p1',
        project_name: 'Mine',
      },
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

    const row = await screen.findByRole('option', { name: /Unlabeled work/ });
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
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Legal go-ahead/ }));
    expect(selectedIndex()).toBe(2);
  });

  it('Enter adds the active cross-project row', async () => {
    searchState.data = CROSS_ROWS;
    setResponse({ pending_acceptance: false });
    renderPicker({ programId: 'prog-1', initialScope: 'program', mode: 'predecessor' });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'e' } });
    await screen.findByRole('listbox', { name: 'Program task results' });

    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('Enter');
    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 'x2', successor: 't-source', dep_type: 'FS', lag: 0 },
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

describe('ScheduleDependencyPicker — Space adds without closing (#3024)', () => {
  it('Space types while the caret owns the keyboard, and adds once ↓ enters the list', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });

    // Before any ↓: the field is a SEARCH field, so Space belongs to the query.
    // This is the whole disambiguation — a planner composing "site plan" must
    // not create a dependency halfway through the phrase.
    expectSpaceTypes();

    pressKey('ArrowDown');
    fireEvent.keyDown(searchInput(), { key: ' ' });

    expect(mutateSpy).toHaveBeenCalledWith(
      { predecessor: 't-local-1', successor: 't-source', dep_type: 'FS', lag: 0 },
      expect.any(Object),
    );
    // The picker STAYS OPEN — that is what makes it multi-add. `Enter` is the
    // only commit that closes.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Add predecessor/ })).toBeInTheDocument();
  });

  it('adds two links in one open, dropping each row as it lands', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    expect(optionNames()).toHaveLength(2);

    pressKey('ArrowDown');
    fireEvent.keyDown(searchInput(), { key: ' ' });
    // The added row leaves the list on its own: `excludedIds` is a prop that
    // cannot refresh until the parent's dependency query refetches, and a second
    // Space on a still-listed row would post a duplicate edge.
    expect(optionNames()).toHaveLength(1);
    expect(optionNames()[0]).toContain('Build feature');

    fireEvent.keyDown(searchInput(), { key: ' ' });
    expect(mutateSpy).toHaveBeenCalledTimes(2);
    expect(mutateSpy.mock.calls[1][0]).toEqual({
      predecessor: 't-local-2',
      successor: 't-source',
      // The terms persist ACROSS a Space multi-add (#3023 step 3) — they are
      // set once for the run rather than reverting to FS/0 between rows, which
      // is what makes "add three SS links" one decision instead of three.
      dep_type: 'FS',
      lag: 0,
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('states a running tally, which is the only feedback a same-project add produces', () => {
    renderPicker();
    pressKey('ArrowDown');
    fireEvent.keyDown(searchInput(), { key: ' ' });
    expect(screen.getByText('Added “Design review” — 1 link added')).toBeInTheDocument();

    fireEvent.keyDown(searchInput(), { key: ' ' });
    expect(screen.getByText('Added “Build feature” — 2 links added')).toBeInTheDocument();
  });

  it('leaves Space alone on a control the user tabbed to (native activation)', () => {
    renderPicker();
    pressKey('ArrowDown');
    // Target is the Close button, not the search field: the window listener must
    // not swallow the key, or Tab-to-Close + Space stops closing the dialog.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: ' ' });
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('typing hands the keyboard back to the caret', () => {
    renderPicker();
    pressKey('ArrowDown');
    expect(activeDescendantOption()).not.toBeNull();

    fireEvent.change(searchInput(), { target: { value: 'e' } });
    expect(activeDescendantOption()).toBeNull();
    expectSpaceTypes();
  });

  it('switching scope hands the keyboard back to the caret', () => {
    renderPicker({ programId: 'prog-1' });
    pressKey('ArrowDown');
    expect(activeDescendantOption()).not.toBeNull();

    pressKey('ArrowRight');
    expect(activeDescendantOption()).toBeNull();
  });

  it('Space is inert when nothing is listed', () => {
    renderPicker();
    pressKey('ArrowDown');
    fireEvent.change(searchInput(), { target: { value: 'nope' } });
    fireEvent.keyDown(searchInput(), { key: ' ' });
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('keeps the modal open on a failed Space-add and surfaces the reason', () => {
    mutateOutcome.error = { response: { data: { detail: 'cyclic_dependency', cycle: [] } } };
    const onClose = vi.fn();
    renderPicker({ onClose });
    pressKey('ArrowDown');
    fireEvent.keyDown(searchInput(), { key: ' ' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The row did NOT leave the list — nothing was linked.
    expect(optionNames()).toHaveLength(2);
  });
});

describe('ScheduleDependencyPicker — aria-activedescendant over a listbox (#3024)', () => {
  it('announces nothing until ↓ walks in', () => {
    renderPicker();
    const input = searchInput();
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input.getAttribute('aria-controls')).toBe(
      screen.getByRole('listbox', { name: 'Task results' }).id,
    );
    // A roving VISUAL highlight with no activedescendant is exactly the defect:
    // the row is styled, and a screen reader is told nothing.
    expect(activeDescendantOption()).toBeNull();
  });

  it('tracks the active row as the arrows move it', () => {
    renderPicker();
    pressKey('ArrowDown');
    const rows = rowOptions();
    expect(activeDescendantOption()).toBe(rows[0]);

    pressKey('ArrowDown');
    expect(activeDescendantOption()).toBe(rowOptions()[1]);
  });

  it('names the row explicitly, so a highlighted name is not read as one word', () => {
    renderPicker();
    fireEvent.change(searchInput(), { target: { value: 'design' } });
    // Accessible-name computation trims each text node before joining, so a name
    // split across <mark>/<span> would announce "Designreview". This is what
    // `aria-activedescendant` makes a screen reader read on every arrow press.
    expect(
      screen.getByRole('option', { name: '1.1 Design review not started' }),
    ).toBeInTheDocument();
  });

  it('tracks a cross-project row across groups', async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(searchInput(), { target: { value: 'e' } });
    await screen.findByRole('listbox', { name: 'Program task results' });

    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    expect(activeDescendantOption()).toBe(rowOptions()[2]);
    // The project header is a group name, not an option — a bare <div> is not a
    // legal listbox child and would announce the project twice.
    expect(screen.getByRole('group', { name: 'Legal' })).toBeInTheDocument();
  });

  it('drops the pointer when the list empties underneath the caret', () => {
    renderPicker();
    pressKey('ArrowDown');
    fireEvent.change(searchInput(), { target: { value: 'nope' } });
    expect(activeDescendantOption()).toBeNull();
    expect(searchInput()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ScheduleDependencyPicker — the match is marked (#3024)', () => {
  it('marks the WBS PREFIX for a leading-digit query, and leaves the name alone', () => {
    renderPicker({
      allTasks: [
        makeTask({ id: 'a', wbs: '1.1', name: 'Design review' }),
        makeTask({ id: 'b', wbs: '1.2', name: 'Build feature' }),
      ],
    });
    fireEvent.change(searchInput(), { target: { value: '1.' } });

    const rows = rowOptions();
    expect(markedText(rows[0])).toEqual(['1.']);
    expect(markedText(rows[1])).toEqual(['1.']);
  });

  it('marks the name SUBSTRING for a non-digit query, and leaves the WBS alone', () => {
    renderPicker({
      allTasks: [makeTask({ id: 'a', wbs: '1.1', name: 'Lay-down area survey' })],
    });
    fireEvent.change(searchInput(), { target: { value: 'lay' } });

    const row = rowOptions()[0];
    // The original casing survives — the mark states where the hit was, it does
    // not restate the query.
    expect(markedText(row)).toEqual(['Lay']);
  });

  it('marks nothing when there is no query', () => {
    renderPicker();
    expect(markedText(rowOptions()[0])).toEqual([]);
  });

  it('a WBS-prefix hit and a name-substring hit are distinguishable', () => {
    // The pairing is the design's stated reason for having both match modes: a
    // planner has to be able to see WHY a row is in the list.
    renderPicker({ allTasks: [makeTask({ id: 'a', wbs: '1.1', name: 'Phase 1 kickoff' })] });

    fireEvent.change(searchInput(), { target: { value: '1.' } });
    const wbsHit = rowOptions()[0];
    expect(within(wbsHit).getByText('1.').tagName).toBe('MARK');

    fireEvent.change(searchInput(), { target: { value: 'kick' } });
    const nameHit = rowOptions()[0];
    expect(within(nameHit).getByText('kick').tagName).toBe('MARK');
    // …and the WBS column carries no mark this time.
    expect(markedText(nameHit)).toEqual(['kick']);
  });

  it("never marks a cross-project row's server-formatted reference", async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    // `SEC-3` is a server id, not a WBS code — prefix semantics do not apply.
    fireEvent.change(searchInput(), { target: { value: '3' } });
    await screen.findByRole('listbox', { name: 'Program task results' });
    for (const row of rowOptions()) expect(markedText(row)).toEqual([]);
  });
});

describe('ScheduleDependencyPicker — the count reads N of M in every scope (#3024)', () => {
  it('reads N of M in project scope when nothing is capped', () => {
    renderPicker();
    expect(screen.getByText('2 of 2 matches')).toBeInTheDocument();
  });

  it('still reads N of M when the 12-row cap bites, and says to narrow', () => {
    renderPicker({
      allTasks: Array.from({ length: 20 }, (_, i) =>
        makeTask({ id: `t${i}`, name: `Task ${i}`, wbs: `1.${i}` }),
      ),
    });
    expect(screen.getByText('12 of 20 matches — keep typing to narrow')).toBeInTheDocument();
  });

  it('singularizes a sole match', () => {
    renderPicker({ allTasks: [makeTask({ id: 'a', name: 'Only one' })] });
    expect(screen.getByText('1 of 1 match')).toBeInTheDocument();
  });

  it('reads N of M in PROGRAM scope, which rendered no count at all', async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(searchInput(), { target: { value: 'e' } });
    await screen.findByRole('listbox', { name: 'Program task results' });
    expect(screen.getByText('3 of 3 matches')).toBeInTheDocument();
  });

  it('counts only linkable rows — an already-linked sibling is not a match', async () => {
    searchState.data = CROSS_ROWS;
    renderPicker({
      programId: 'prog-1',
      initialScope: 'program',
      excludedIds: new Set(['x1']),
    });
    fireEvent.change(searchInput(), { target: { value: 'e' } });
    await screen.findByRole('listbox', { name: 'Program task results' });
    expect(screen.getByText('2 of 2 matches')).toBeInTheDocument();
  });

  it('drops the count with the list once a Space-add empties it', () => {
    renderPicker({ allTasks: [makeTask({ id: 'a', name: 'Only one' })] });
    pressKey('ArrowDown');
    fireEvent.keyDown(searchInput(), { key: ' ' });
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
    expect(screen.getByText('No matching tasks. Try a different search.')).toBeInTheDocument();
  });
});

describe('ScheduleDependencyPicker — a commit key is a commit only from the field (#3024)', () => {
  it('Enter on the Tabbed-to Close button closes, and does NOT link', () => {
    // The focus trap's Tab cycle reaches ×. Without a target guard the window
    // listener preventDefault()s the native activation and submits the
    // highlighted row instead — the dialog closes either way, so the user sees
    // "Close worked" and a dependency they never asked for.
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Enter' });
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('Enter is inert on an empty list for the right reason', () => {
    // Fired from the field, so the target guard is satisfied and the emptiness
    // is what makes it inert — otherwise this passes without exercising it.
    renderPicker();
    fireEvent.change(searchInput(), { target: { value: 'nope' } });
    expect(rowOptions()).toHaveLength(0);
    pressKey('Enter');
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});

describe('ScheduleDependencyPicker — the footer states which mode you are in (#3024)', () => {
  it('does not promise Space while the caret still owns the keyboard', () => {
    renderPicker();
    expect(screen.getByText('↓ into list · Enter add & close · Esc cancel')).toBeInTheDocument();
  });

  it('promises Space once ↓ has entered the list', () => {
    renderPicker();
    pressKey('ArrowDown');
    expect(
      screen.getByText('↑↓ move · Space add · Enter add & close · Esc cancel'),
    ).toBeInTheDocument();
  });

  it('keeps the scope hint in both modes for a programmed project', () => {
    renderPicker({ programId: 'prog-1' });
    expect(
      screen.getByText('←→ scope · ↓ into list · Enter add & close · Esc cancel'),
    ).toBeInTheDocument();
    pressKey('ArrowDown');
    expect(
      screen.getByText('←→ scope · ↑↓ move · Space add · Enter add & close · Esc cancel'),
    ).toBeInTheDocument();
  });
});

describe('ScheduleDependencyPicker — program scope marks what the SERVER matched (#3024)', () => {
  it('marks a digit query as a name substring, because the server has no WBS prefix', async () => {
    // `task_search` runs `name__icontains` — never a prefix, and a cross-project
    // row has no WBS to prefix. Deriving `wbs-prefix` from the leading digit
    // marked nothing at all, on a query that really did match a name.
    searchState.data = [
      {
        id: 'x9',
        name: 'Phase 2 handover',
        short_id: '00000009',
        short_id_display: 'T-9',
        qualified_id: 'OPS-9',
        project_id: 'p-ops',
        project_name: 'Ops',
      },
    ];
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(searchInput(), { target: { value: '2' } });
    await screen.findByRole('listbox', { name: 'Program task results' });
    expect(markedText(rowOptions()[0])).toEqual(['2']);
  });

  it('says to narrow when the server hit its 200-row ceiling', async () => {
    // At the cap the count would otherwise read "200 of 200 matches" — stating a
    // completeness the endpoint never claimed.
    searchState.data = Array.from({ length: 200 }, (_, i) => ({
      id: `x${i}`,
      name: `Handover ${i}`,
      short_id: `0000${i}`,
      short_id_display: `T-${i}`,
      qualified_id: `OPS-${i}`,
      project_id: 'p-ops',
      project_name: 'Ops',
    }));
    renderPicker({ programId: 'prog-1', initialScope: 'program' });
    fireEvent.change(searchInput(), { target: { value: 'handover' } });
    await screen.findByRole('listbox', { name: 'Program task results' });
    expect(screen.getByText('200 of 200 matches — keep typing to narrow')).toBeInTheDocument();
  });
});

describe('ScheduleDependencyPicker — the count describes, it does not shout (#3024)', () => {
  it('reaches a screen reader through aria-describedby, not a live region', () => {
    // It changes on every keystroke. As `role="status"` it would speak over the
    // field's own typing echo and over the row announcement the planner is
    // navigating by (web rule 316).
    renderPicker();
    const count = screen.getByText('2 of 2 matches');
    expect(count).not.toHaveAttribute('role', 'status');
    expect(searchInput().getAttribute('aria-describedby')).toBe(count.id);
  });

  it('drops the description with the count', () => {
    renderPicker();
    fireEvent.change(searchInput(), { target: { value: 'nope' } });
    expect(searchInput()).not.toHaveAttribute('aria-describedby');
  });

  it('keeps the added-links tally as a live region — that one IS an event', () => {
    renderPicker();
    pressKey('ArrowDown');
    pressKey(' ');
    expect(screen.getByRole('status')).toHaveTextContent('Added “Design review” — 1 link added');
  });
});

// ---------------------------------------------------------------------------
// The picker writes the WHOLE link — type and lead/lag (#3023 step 3)
// ---------------------------------------------------------------------------

describe('ScheduleDependencyPicker — the link terms (#3023 step 3)', () => {
  /** The link-type `<select>`. Named, not positional — the dialog's other
   *  combobox is the search field, and #3024's whole subject is that the two
   *  must not be confused. */
  function typeSelect(): HTMLSelectElement {
    return screen.getByLabelText('Link');
  }
  function lagInput(): HTMLInputElement {
    return screen.getByLabelText('Lag days');
  }

  /** Walk into the list and commit the active row with Enter. */
  function commitFirstRow() {
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput(), { key: 'Enter' });
  }

  it('offers the four types, in the canonical order, from the shared vocabulary', () => {
    renderPicker();
    // Order is load-bearing, not cosmetic: `depFlag` sorts by it so two rows
    // with the same links read the same regardless of arrival order, and `⌥→`
    // cycles through it. Before #3023 it was declared in three files.
    expect(
      within(typeSelect())
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['FS', 'SS', 'FF', 'SF']);
  });

  it('sends the chosen type instead of hardcoding FS', () => {
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(typeSelect(), { target: { value: 'SS' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ dep_type: 'SS' });
  });

  it('sends a positive lag', () => {
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(lagInput(), { target: { value: '3' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ lag: 3 });
  });

  it('sends a NEGATIVE lag as a lead, which is the whole reason the field is signed', () => {
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(lagInput(), { target: { value: '-2' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ lag: -2 });
  });

  it('treats an emptied field as 0 rather than sending NaN', () => {
    // The field is held as text precisely so this case has ONE answer in ONE
    // place. A number state would have to decide what "" means at every read.
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(lagInput(), { target: { value: '' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ lag: 0 });
  });

  it('treats a lone minus sign as 0 — mid-typing a lead is not a value yet', () => {
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(lagInput(), { target: { value: '-' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ lag: 0 });
  });

  it('clamps to the bounds the DRAWER enforces, so it cannot mint an uneditable link', () => {
    // The drawer owns editing and refuses beyond ±365. A picker that could
    // create 400 would produce a link its own edit surface rejects.
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(lagInput(), { target: { value: '9999' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ lag: 365 });

    mutateSpy.mockClear();
    fireEvent.change(lagInput(), { target: { value: '-9999' } });
    commitFirstRow();
    expect(mutateSpy.mock.calls[0][0]).toMatchObject({ lag: -365 });
  });

  it('carries the terms across a Space multi-add, so a run of SS links is one decision', () => {
    renderPicker();
    mutateSpy.mockClear();
    fireEvent.change(typeSelect(), { target: { value: 'FF' } });
    fireEvent.change(lagInput(), { target: { value: '5' } });

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput(), { key: ' ' });
    fireEvent.keyDown(searchInput(), { key: ' ' });

    expect(mutateSpy).toHaveBeenCalledTimes(2);
    for (const call of mutateSpy.mock.calls) {
      expect(call[0]).toMatchObject({ dep_type: 'FF', lag: 5 });
    }
  });

  it('leaves the row caret alone when an arrow key is pressed INSIDE the terms', () => {
    // The regression this change would otherwise have introduced. Every arrow
    // binding steers the result list and calls preventDefault(), so without a
    // focus-target guard, `↓` inside the type select — the way you choose SS —
    // would move the row highlight and never reach the control. Space and Enter
    // already carried this guard; the arrows did not, because until now there
    // was nothing else in the dialog to Tab to.
    renderPicker();
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' }); // enter the list
    expect(selectedIndex()).toBe(0);
    // Enough rows that a move is observable. The first draft of this test
    // pressed ↓ ↓ ↑ and passed with the guard REMOVED: the fixture has two
    // rows, so the second ↓ clamped and the ↑ undid the first — a
    // self-cancelling sequence that measured nothing. One press from a known
    // index is what makes the assertion bite.
    expect(rowOptions().length).toBeGreaterThan(1);

    fireEvent.keyDown(typeSelect(), { key: 'ArrowDown' });
    expect(selectedIndex()).toBe(0);
  });

  it('leaves the row caret alone when ↑ is pressed inside the terms', () => {
    // The other direction, from a non-zero index so it cannot pass by clamping.
    renderPicker();
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' }); // enter at 0
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' }); // move to 1
    expect(selectedIndex()).toBe(1);

    fireEvent.keyDown(lagInput(), { key: 'ArrowUp' });
    expect(selectedIndex()).toBe(1);
  });

  it('does not commit a link when Enter is pressed inside the terms', () => {
    // Same guard, sharper consequence: Enter in a number field is a form-submit
    // idiom, and swallowing it here would write an edge the user never picked.
    renderPicker();
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    mutateSpy.mockClear();
    fireEvent.keyDown(lagInput(), { key: 'Enter' });
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});
