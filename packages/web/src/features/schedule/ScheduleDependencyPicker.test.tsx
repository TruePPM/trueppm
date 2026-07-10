import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { Task } from '@/types';
import type { ProgramTaskResult } from '@/features/programs/hooks/useProgramTaskSearch';
import { ScheduleDependencyPicker } from './ScheduleDependencyPicker';

// mutate() invokes onSuccess synchronously with the response so the consent
// toast branch (pending vs accepted) is deterministic. `response` is mutated
// per-test to simulate the ADR-0120 D2 consent outcome.
const { mutateSpy, infoSpy, successSpy, errorSpy, searchState } = vi.hoisted(() => ({
  mutateSpy: vi.fn(
    (
      _payload: unknown,
      opts?: { onSuccess?: (data: unknown) => void; onError?: (e: unknown) => void },
    ) => opts?.onSuccess?.((globalThis as Record<string, unknown>).__depResponse),
  ),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  errorSpy: vi.fn(),
  searchState: { data: [] as ProgramTaskResult[], isLoading: false, isError: false },
}));

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
    refetch: vi.fn(),
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
  setResponse({});
});

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
