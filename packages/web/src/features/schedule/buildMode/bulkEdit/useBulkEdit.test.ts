import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Task } from '@/types';
// Type-only imports survive the vi.mock below — types are erased at runtime.
import type { BulkUpdateOperation, TaskBulkResponse } from '@/hooks/useTaskMutations';
import type { UseScheduleFocusReturn } from '../useScheduleFocus';
import { useBulkEdit } from './useBulkEdit';
import { EMPTY_BULK_EDIT_SPEC } from './bulkEditSpec';

/** The `mutate(ops, { onSuccess, onError })` surface the hook actually calls. */
interface MutateCallbacks {
  onSuccess: (data: TaskBulkResponse) => void;
  onError: (error: Error) => void;
}

const mutate = vi.fn<(ops: BulkUpdateOperation[], cbs: MutateCallbacks) => void>();
let isPending = false;

vi.mock('@/hooks/useTaskMutations', () => ({
  useBulkUpdateTasks: () => ({ mutate, isPending }),
}));

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    wbs: '1',
    name: id,
    start: '2026-03-01',
    finish: '2026-03-05',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'todo',
    assignees: [],
    ...over,
  } as Task;
}

const VISIBLE = [task('t1'), task('t2'), task('t3')];

function makeFocus(over: Partial<UseScheduleFocusReturn['state']> = {}): UseScheduleFocusReturn {
  return {
    state: {
      mode: 'RowFocused',
      rowId: null,
      column: null,
      selectedIds: null,
      selectionAnchorId: null,
      ...over,
    },
    selectIds: vi.fn(),
    focusRow: vi.fn(),
    clear: vi.fn(),
  } as unknown as UseScheduleFocusReturn;
}

function setup(focus: UseScheduleFocusReturn, readOnly = false) {
  const focusRowById = vi.fn();
  const view = renderHook(() =>
    useBulkEdit({ projectId: 'p1', focus, visibleTasks: VISIBLE, readOnly, focusRowById }),
  );
  return { ...view, focusRowById };
}

beforeEach(() => {
  mutate.mockReset();
  isPending = false;
});

describe('useBulkEdit — resolving the selection', () => {
  it('uses the multi-row selection, ordered by the visible list not Set order', () => {
    const focus = makeFocus({ selectedIds: new Set(['t3', 't1']), rowId: 't3' });
    const { result } = setup(focus);
    expect(result.current.selectedTasks.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('treats the focused row as a selection of one — the rule ⌫ already uses', () => {
    const { result } = setup(makeFocus({ rowId: 't2' }));
    expect(result.current.selectedTasks.map((t) => t.id)).toEqual(['t2']);
  });
});

describe('useBulkEdit — open', () => {
  it('opens with a selection', () => {
    const { result } = setup(makeFocus({ selectedIds: new Set(['t1']), rowId: 't1' }));
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
  });

  it('is a no-op with nothing selected and nothing focused — never an empty sheet', () => {
    const { result } = setup(makeFocus());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(false);
  });

  it('is a no-op in read-only mode', () => {
    const { result } = setup(makeFocus({ rowId: 't1' }), true);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(false);
  });
});

describe('useBulkEdit — apply', () => {
  it('sends one update op per selected row', () => {
    const { result } = setup(makeFocus({ selectedIds: new Set(['t1', 't2']), rowId: 't2' }));
    act(() => result.current.open());
    act(() => result.current.apply({ ...EMPTY_BULK_EDIT_SPEC, deliveryMode: 'scrum' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual([
      { op: 'update', id: 't1', data: { delivery_mode: 'scrum' } },
      { op: 'update', id: 't2', data: { delivery_mode: 'scrum' } },
    ]);
  });

  it('reports a locally-empty batch as a result instead of POSTing no operations', () => {
    // Owner-only edit over a selection of nothing but summary rows: every row is
    // dropped client-side, and an empty `operations` array is a request the
    // server would reject for no reason.
    const summaryOnly = [task('sum', { isSummary: true })];
    const focus = makeFocus({ selectedIds: new Set(['sum']), rowId: 'sum' });
    const { result } = renderHook(() =>
      useBulkEdit({
        projectId: 'p1',
        focus,
        visibleTasks: summaryOnly,
        readOnly: false,
        focusRowById: vi.fn(),
      }),
    );
    act(() => result.current.open());
    act(() =>
      result.current.apply({
        ...EMPTY_BULK_EDIT_SPEC,
        owner: { mode: 'add', resourceId: 'r-ana', resourceName: 'Ana', percent: 100 },
      }),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.result).toEqual({
      applied: [],
      rejected: [],
      skipped: [],
      capabilities_denied: [],
      operation_id: null,
    });
    expect(result.current.skippedLocallyIds).toEqual(['sum']);
  });

  it('surfaces a transport failure as an inline error, keeping the sheet open', () => {
    mutate.mockImplementation((_ops, opts) => {
      opts.onError(new Error('nope'));
    });
    const { result } = setup(makeFocus({ rowId: 't1' }));
    act(() => result.current.open());
    act(() => result.current.apply({ ...EMPTY_BULK_EDIT_SPEC, deliveryMode: 'scrum' }));
    expect(result.current.error).toEqual({
      message: 'Couldn’t apply the changes.',
      detail: null,
      // A bare Error is not an axios client rejection — the server never
      // decided, so a replay may well land.
      retryable: true,
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.result).toBeNull();
  });

  it('stores the 207 body so the result phase can break it down', () => {
    const body = {
      applied: [{ index: 0, id: 't1', op: 'update' as const, outcome: 'updated' as const }],
      rejected: [{ index: 1, id: 't2', code: 'forbidden' as const, message: 'No edit access.' }],
      skipped: [],
      capabilities_denied: [],
      operation_id: null,
    };
    mutate.mockImplementation((_ops, opts) => {
      opts.onSuccess(body);
    });
    const { result } = setup(makeFocus({ selectedIds: new Set(['t1', 't2']), rowId: 't2' }));
    act(() => result.current.open());
    act(() => result.current.apply({ ...EMPTY_BULK_EDIT_SPEC, deliveryMode: 'scrum' }));
    expect(result.current.result).toEqual(body);
  });
});

describe('useBulkEdit — done (S20)', () => {
  it('clears the selection on a CLEAN result — the act is over', () => {
    // Leaving fifteen rows highlighted after a clean batch invites a second,
    // accidental pass over the same selection.
    const focus = makeFocus({ selectedIds: new Set(['t1']), rowId: 't1' });
    const { result } = renderHook(() =>
      useBulkEdit({
        projectId: 'p1',
        focus,
        visibleTasks: [task('t1')],
        readOnly: false,
        focusRowById: vi.fn(),
      }),
    );
    act(() => result.current.open());
    act(() => result.current.done(true));
    expect(focus.clear).toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);
  });

  it('KEEPS the selection on a partial result, so ⌘⇧K is the retry', () => {
    const focus = makeFocus({ selectedIds: new Set(['t1']), rowId: 't1' });
    const { result } = renderHook(() =>
      useBulkEdit({
        projectId: 'p1',
        focus,
        visibleTasks: [task('t1')],
        readOnly: false,
        focusRowById: vi.fn(),
      }),
    );
    act(() => result.current.open());
    act(() => result.current.done(false));
    expect(focus.clear).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);
  });
});

describe('useBulkEdit — reviewFailed', () => {
  it('re-selects exactly the failed rows, focuses the first, and closes', () => {
    const focus = makeFocus({ selectedIds: new Set(['t1', 't2', 't3']), rowId: 't3' });
    const { result, focusRowById } = setup(focus);
    act(() => result.current.open());
    act(() => result.current.reviewFailed(['t2', 't3']));
    expect(focus.selectIds).toHaveBeenCalledWith(['t2', 't3']);
    expect(focus.focusRow).toHaveBeenCalledWith('t2');
    // The row may be virtualized out — DOM focus is retried, not assumed.
    expect(focusRowById).toHaveBeenCalledWith('t2');
    expect(result.current.isOpen).toBe(false);
  });

  it('does nothing when there are no navigable failed rows', () => {
    const focus = makeFocus({ rowId: 't1' });
    const { result } = setup(focus);
    act(() => result.current.reviewFailed([]));
    expect(focus.selectIds).not.toHaveBeenCalled();
  });
});
