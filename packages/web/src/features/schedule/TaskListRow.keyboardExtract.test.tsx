/**
 * Characterization tests for the two lower-covered keyboard branches on
 * TaskListRow that the #2081 cognitive-complexity extraction moves into
 * module-level helpers (`handleBuildModeKeyDown`, `handleRowKeyDown`):
 *
 *   - Option/Alt+↑/↓ sibling reorder (#347) — build-mode path.
 *   - ⌘D / Ctrl+D duplicate (ADR-0066 Q1) — flag-off path.
 *
 * They pin the exact mutate payloads so the pure extraction is provably
 * behavior-preserving. The mutation hooks are partially mocked so the calls
 * are observable without a live API.
 */
import { useMemo } from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const reorderMutate = vi.fn();
const duplicateMutate = vi.fn();

vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useReorderTasks: () => ({ mutate: reorderMutate }) as never,
    useDuplicateTask: () => ({ mutate: duplicateMutate }) as never,
  };
});

// Imported AFTER the mock is registered so the component picks up the mocked hooks.
const { TaskListRow } = await import('./TaskListRow');
const { BuildModeProvider } = await import('./buildMode/BuildModeContext');
const { useScheduleFocus } = await import('./buildMode');
type BuildModeApi = import('./buildMode').BuildModeApi;

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 220, links: 76, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, links: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const baseTask: Task = {
  id: 't-r1', wbs: '1.2', name: 'Foundation',
  start: '2026-04-05', finish: '2026-04-09',
  duration: 5, progress: 0, parentId: 't-r0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

describe('TaskListRow — Option/Alt+↑/↓ sibling reorder (#347)', () => {
  beforeEach(() => vi.clearAllMocks());

  function ReorderHarness({ capture }: { capture: { current: { focusRow: (id: string) => void } | null } }) {
    const focus = useScheduleFocus();
    const api = useMemo<BuildModeApi>(
      () => ({
        focus,
        indent: vi.fn(),
        outdent: vi.fn(),
        insertBelow: vi.fn(),
        insertAbove: vi.fn(),
        insertChild: vi.fn(),
        mergeIntoPreviousRow: vi.fn(),
        isCaretAtEndRow: () => false,
        clearCaretAtEndRow: vi.fn(),
        convertToMilestone: vi.fn(),
        duplicateSubtree: vi.fn(),
        deleteTask: vi.fn(),
        isMutationPending: () => false,
      }),
      [focus],
    );
    capture.current = { focusRow: focus.focusRow };
    return (
      <BuildModeProvider api={api}>
        <TaskListRow
          task={baseTask}
          level={2}
          widths={widths}
          visible={visible}
          siblingIds={['t-r1', 't-r2']}
        />
      </BuildModeProvider>
    );
  }

  it('Alt+ArrowDown reorders the focused row after its next sibling', () => {
    const capture: { current: { focusRow: (id: string) => void } | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/projects/:projectId/schedule" element={<ReorderHarness capture={capture} />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    act(() => capture.current!.focusRow('t-r1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'ArrowDown', altKey: true });
    expect(reorderMutate).toHaveBeenCalledWith({
      parent_path: '1',
      ordered_ids: ['t-r2', 't-r1'],
    });
  });

  it('Alt+ArrowUp at the top of the sibling list is a no-op', () => {
    const capture: { current: { focusRow: (id: string) => void } | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/projects/:projectId/schedule" element={<ReorderHarness capture={capture} />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    act(() => capture.current!.focusRow('t-r1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'ArrowUp', altKey: true });
    expect(reorderMutate).not.toHaveBeenCalled();
  });
});

describe('TaskListRow — ⌘D / Ctrl+D duplicate (flag-off, ADR-0066 Q1)', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderRow() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route
              path="/projects/:projectId/schedule"
              element={
                <TaskListRow
                  task={baseTask}
                  level={2}
                  widths={widths}
                  visible={visible}
                  siblingNames={['Foundation']}
                />
              }
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('Ctrl+D duplicates the row with the source task snapshot', () => {
    renderRow();
    fireEvent.keyDown(screen.getByRole('row'), { key: 'd', ctrlKey: true });
    expect(duplicateMutate).toHaveBeenCalledTimes(1);
    const payload = duplicateMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      projectId: 'p1',
      source: { name: 'Foundation', duration: 5, parent_id: 't-r0', is_milestone: false },
    });
  });
});

/**
 * #3079 — the `enterCreatesRow` display preference.
 *
 * Since #1666 a plain Enter commits AND inserts a sibling below, which is the
 * right default for rapid sequence entry and the wrong one for renaming rows that
 * already exist: every commit spawned a blank row that then had to be deleted.
 *
 * The pins that matter are the two the preference must NOT change. Modifiers are
 * explicit insert gestures and still insert, and the file's stated mental model —
 * "Enter always ends with the cursor in an editable Name cell" — has to survive
 * turning row creation off, or the setting quietly breaks the keyboard model.
 */
describe('TaskListRow — Enter creates a new row (#3079)', () => {
  beforeEach(() => vi.clearAllMocks());

  const spies = {
    insertBelow: vi.fn(),
    insertAbove: vi.fn(),
    insertChild: vi.fn(),
    enterCellEdit: vi.fn(),
  };

  function EnterHarness({
    enterCreatesRow,
    capture,
  }: {
    enterCreatesRow?: boolean;
    capture: { current: { focusRow: (id: string) => void } | null };
  }) {
    const focus = useScheduleFocus();
    const api = useMemo<BuildModeApi>(
      () => ({
        focus: { ...focus, enterCellEdit: spies.enterCellEdit },
        indent: vi.fn(),
        outdent: vi.fn(),
        insertBelow: spies.insertBelow,
        insertAbove: spies.insertAbove,
        insertChild: spies.insertChild,
        mergeIntoPreviousRow: vi.fn(),
        isCaretAtEndRow: () => false,
        clearCaretAtEndRow: vi.fn(),
        convertToMilestone: vi.fn(),
        duplicateSubtree: vi.fn(),
        deleteTask: vi.fn(),
        isMutationPending: () => false,
        ...(enterCreatesRow === undefined ? {} : { enterCreatesRow }),
      }),
      [focus, enterCreatesRow],
    );
    capture.current = { focusRow: focus.focusRow };
    return (
      <BuildModeProvider api={api}>
        <TaskListRow
          task={baseTask}
          level={2}
          widths={widths}
          visible={visible}
          siblingIds={['t-r1', 't-r2']}
        />
      </BuildModeProvider>
    );
  }

  function pressEnter(
    enterCreatesRow: boolean | undefined,
    mods: { shiftKey?: boolean; metaKey?: boolean } = {},
  ) {
    const capture: { current: { focusRow: (id: string) => void } | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route
              path="/projects/:projectId/schedule"
              element={<EnterHarness enterCreatesRow={enterCreatesRow} capture={capture} />}
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    act(() => capture.current!.focusRow('t-r1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter', ...mods });
  }

  it('on (the default) keeps #1666: Enter inserts a sibling below', () => {
    pressEnter(true);
    expect(spies.insertBelow).toHaveBeenCalledWith('t-r1');
  });

  it('off: Enter does not insert a row', () => {
    pressEnter(false);
    expect(spies.insertBelow).not.toHaveBeenCalled();
  });

  it('off: Enter still ends with the cursor in an editable Name cell', () => {
    pressEnter(false);
    expect(spies.enterCellEdit).toHaveBeenCalledWith('t-r1', 'name');
  });

  it('off: Shift+Enter still inserts above — a modifier is an explicit insert', () => {
    pressEnter(false, { shiftKey: true });
    expect(spies.insertAbove).toHaveBeenCalledWith('t-r1');
  });

  it('off: ⌘/Ctrl+Enter still inserts a child', () => {
    pressEnter(false, { metaKey: true });
    expect(spies.insertChild).toHaveBeenCalledWith('t-r1');
  });

  // A BuildModeApi mock that predates this preference must not silently lose row
  // creation — absent has to read as the shipped default, not as "off".
  it('absent reads as on, so an un-updated caller is unchanged', () => {
    pressEnter(undefined);
    expect(spies.insertBelow).toHaveBeenCalledWith('t-r1');
  });
});
