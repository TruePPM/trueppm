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
  wbs: 48, task: 220, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, dur: true, start: true, finish: true, progress: true, owner: true,
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
        convertToMilestone: vi.fn(),
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
