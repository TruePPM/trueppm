import { describe, expect, it } from 'vitest';
import {
  EDITABLE_COLUMNS,
  INITIAL_FOCUS_STATE,
  scheduleFocusReducer,
  type ScheduleFocusState,
} from './useScheduleFocus';

const TASK_A = 'task-a';
const TASK_B = 'task-b';
const TASK_C = 'task-c';

/** Shorthand for a plain RowFocused state with no active multi-selection. */
function rowFocused(rowId: string): ScheduleFocusState {
  return { mode: 'RowFocused', rowId, column: null, selectedIds: null, selectionAnchorId: null };
}

/** Shorthand for a plain CellEdit state. */
function cellEdit(rowId: string, column: (typeof EDITABLE_COLUMNS)[number]): ScheduleFocusState {
  return { mode: 'CellEdit', rowId, column, selectedIds: null, selectionAnchorId: null };
}

describe('scheduleFocusReducer — initial state', () => {
  it('starts in NoSelection with no row, column, or selection', () => {
    expect(INITIAL_FOCUS_STATE).toEqual({
      mode: 'NoSelection',
      rowId: null,
      column: null,
      selectedIds: null,
      selectionAnchorId: null,
    });
  });
});

describe('scheduleFocusReducer — FOCUS_ROW', () => {
  it('moves NoSelection → RowFocused', () => {
    const next = scheduleFocusReducer(INITIAL_FOCUS_STATE, {
      type: 'FOCUS_ROW',
      rowId: TASK_A,
    });
    expect(next).toEqual(rowFocused(TASK_A));
  });

  it('replaces an active row with the new one', () => {
    const a = scheduleFocusReducer(INITIAL_FOCUS_STATE, {
      type: 'FOCUS_ROW',
      rowId: TASK_A,
    });
    const b = scheduleFocusReducer(a, { type: 'FOCUS_ROW', rowId: TASK_B });
    expect(b.rowId).toBe(TASK_B);
  });

  it('exits CellEdit when a different row is focused', () => {
    const focused = scheduleFocusReducer(INITIAL_FOCUS_STATE, {
      type: 'FOCUS_ROW',
      rowId: TASK_A,
    });
    const editing = scheduleFocusReducer(focused, {
      type: 'ENTER_CELL_EDIT',
      rowId: TASK_A,
      column: 'name',
    });
    const moved = scheduleFocusReducer(editing, {
      type: 'FOCUS_ROW',
      rowId: TASK_B,
    });
    expect(moved.mode).toBe('RowFocused');
    expect(moved.column).toBeNull();
  });

  it('collapses an active multi-row selection back to the single new row (#2727)', () => {
    const selecting = scheduleFocusReducer(rowFocused(TASK_A), {
      type: 'EXTEND_SELECTION',
      toRowId: TASK_B,
      visibleOrder: [TASK_A, TASK_B, TASK_C],
    });
    expect(selecting.selectedIds).toEqual(new Set([TASK_A, TASK_B]));
    const collapsed = scheduleFocusReducer(selecting, { type: 'FOCUS_ROW', rowId: TASK_C });
    expect(collapsed).toEqual(rowFocused(TASK_C));
  });
});

describe('scheduleFocusReducer — ENTER_CELL_EDIT', () => {
  it('throws when called from NoSelection (illegal transition)', () => {
    expect(() =>
      scheduleFocusReducer(INITIAL_FOCUS_STATE, {
        type: 'ENTER_CELL_EDIT',
        rowId: TASK_A,
        column: 'name',
      }),
    ).toThrow(/NoSelection/);
  });

  it('moves RowFocused → CellEdit on the same row', () => {
    const focused = scheduleFocusReducer(INITIAL_FOCUS_STATE, {
      type: 'FOCUS_ROW',
      rowId: TASK_A,
    });
    const editing = scheduleFocusReducer(focused, {
      type: 'ENTER_CELL_EDIT',
      rowId: TASK_A,
      column: 'name',
    });
    expect(editing).toEqual(cellEdit(TASK_A, 'name'));
  });

  it('moves between cells in CellEdit by re-entering with a new column', () => {
    const editing = scheduleFocusReducer(cellEdit(TASK_A, 'name'), {
      type: 'ENTER_CELL_EDIT',
      rowId: TASK_A,
      column: 'duration',
    });
    expect(editing.column).toBe('duration');
  });

  it('clears an active multi-row selection on entering cell edit (#2727)', () => {
    const selecting = scheduleFocusReducer(rowFocused(TASK_A), {
      type: 'SELECT_IDS',
      ids: [TASK_A, TASK_B],
    });
    const editing = scheduleFocusReducer(selecting, {
      type: 'ENTER_CELL_EDIT',
      rowId: TASK_A,
      column: 'name',
    });
    expect(editing).toEqual(cellEdit(TASK_A, 'name'));
  });
});

describe('scheduleFocusReducer — COMMIT_TO_ROW / ROLLBACK_TO_ROW', () => {
  it('returns CellEdit → RowFocused on commit', () => {
    const next = scheduleFocusReducer(cellEdit(TASK_A, 'name'), { type: 'COMMIT_TO_ROW' });
    expect(next).toEqual(rowFocused(TASK_A));
  });

  it('returns CellEdit → RowFocused on rollback (semantic distinction handled by caller)', () => {
    const next = scheduleFocusReducer(cellEdit(TASK_A, 'name'), { type: 'ROLLBACK_TO_ROW' });
    expect(next).toEqual(rowFocused(TASK_A));
  });

  it('is a no-op outside CellEdit', () => {
    const focused = rowFocused(TASK_A);
    expect(scheduleFocusReducer(focused, { type: 'COMMIT_TO_ROW' })).toEqual(focused);
    expect(scheduleFocusReducer(INITIAL_FOCUS_STATE, { type: 'ROLLBACK_TO_ROW' })).toEqual(
      INITIAL_FOCUS_STATE,
    );
  });

  it('rollback returns to the same row that was being edited (never NoSelection)', () => {
    const next = scheduleFocusReducer(cellEdit(TASK_A, 'name'), { type: 'ROLLBACK_TO_ROW' });
    expect(next.rowId).toBe(TASK_A);
  });
});

describe('scheduleFocusReducer — TAB_FORWARD in CellEdit', () => {
  it('advances to the next editable column', () => {
    const next = scheduleFocusReducer(cellEdit(TASK_A, 'name'), { type: 'TAB_FORWARD' });
    expect(next.column).toBe('duration');
  });

  it('falls back to RowFocused on the last column (caller wraps)', () => {
    const last = EDITABLE_COLUMNS[EDITABLE_COLUMNS.length - 1];
    const next = scheduleFocusReducer(cellEdit(TASK_A, last), { type: 'TAB_FORWARD' });
    expect(next).toEqual(rowFocused(TASK_A));
  });

  it('is a no-op in RowFocused (Tab=indent is handled externally)', () => {
    const focused = rowFocused(TASK_A);
    expect(scheduleFocusReducer(focused, { type: 'TAB_FORWARD' })).toEqual(focused);
  });

  it('is a no-op in NoSelection (browser default Tab applies)', () => {
    expect(scheduleFocusReducer(INITIAL_FOCUS_STATE, { type: 'TAB_FORWARD' })).toEqual(
      INITIAL_FOCUS_STATE,
    );
  });
});

describe('scheduleFocusReducer — TAB_BACKWARD in CellEdit', () => {
  it('moves to the previous editable column', () => {
    const next = scheduleFocusReducer(cellEdit(TASK_A, 'duration'), { type: 'TAB_BACKWARD' });
    expect(next.column).toBe('name');
  });

  it('falls back to RowFocused on the first column', () => {
    const first = EDITABLE_COLUMNS[0];
    const next = scheduleFocusReducer(cellEdit(TASK_A, first), { type: 'TAB_BACKWARD' });
    expect(next).toEqual(rowFocused(TASK_A));
  });
});

describe('scheduleFocusReducer — CLEAR', () => {
  it('returns to NoSelection from any state', () => {
    expect(scheduleFocusReducer(cellEdit(TASK_A, 'name'), { type: 'CLEAR' })).toEqual(
      INITIAL_FOCUS_STATE,
    );
    expect(scheduleFocusReducer(rowFocused(TASK_A), { type: 'CLEAR' })).toEqual(
      INITIAL_FOCUS_STATE,
    );
  });

  it('clears an active multi-row selection too', () => {
    const selecting = scheduleFocusReducer(rowFocused(TASK_A), {
      type: 'SELECT_IDS',
      ids: [TASK_A, TASK_B],
    });
    expect(scheduleFocusReducer(selecting, { type: 'CLEAR' })).toEqual(INITIAL_FOCUS_STATE);
  });
});

describe('scheduleFocusReducer — Tab disambiguation invariant (the central guarantee)', () => {
  it('Tab in RowFocused does not change focus state (caller fires indent)', () => {
    const focused = rowFocused(TASK_A);
    const next = scheduleFocusReducer(focused, { type: 'TAB_FORWARD' });
    expect(next).toEqual(focused);
  });

  it('Tab in CellEdit advances column (caller does not fire indent)', () => {
    const editing = cellEdit(TASK_A, 'name');
    const next = scheduleFocusReducer(editing, { type: 'TAB_FORWARD' });
    expect(next.mode).toBe('CellEdit');
    expect(next.column).toBe('duration');
  });
});

describe('scheduleFocusReducer — EXTEND_SELECTION (#2727, ADR-0776 §1)', () => {
  const VISIBLE = [TASK_A, TASK_B, TASK_C];

  it('is a no-op from NoSelection — nothing to extend from', () => {
    expect(
      scheduleFocusReducer(INITIAL_FOCUS_STATE, {
        type: 'EXTEND_SELECTION',
        toRowId: TASK_B,
        visibleOrder: VISIBLE,
      }),
    ).toEqual(INITIAL_FOCUS_STATE);
  });

  it('extends downward from the anchor, moving rowId to the new edge', () => {
    const next = scheduleFocusReducer(rowFocused(TASK_A), {
      type: 'EXTEND_SELECTION',
      toRowId: TASK_B,
      visibleOrder: VISIBLE,
    });
    expect(next.rowId).toBe(TASK_B);
    expect(next.selectedIds).toEqual(new Set([TASK_A, TASK_B]));
    expect(next.selectionAnchorId).toBe(TASK_A);
  });

  it('extends upward from the anchor when toRowId precedes it', () => {
    const next = scheduleFocusReducer(rowFocused(TASK_B), {
      type: 'EXTEND_SELECTION',
      toRowId: TASK_A,
      visibleOrder: VISIBLE,
    });
    expect(next.selectedIds).toEqual(new Set([TASK_A, TASK_B]));
    expect(next.selectionAnchorId).toBe(TASK_B);
  });

  it('a second extend keeps the same fixed anchor and grows the range further', () => {
    const first = scheduleFocusReducer(rowFocused(TASK_A), {
      type: 'EXTEND_SELECTION',
      toRowId: TASK_B,
      visibleOrder: VISIBLE,
    });
    const second = scheduleFocusReducer(first, {
      type: 'EXTEND_SELECTION',
      toRowId: TASK_C,
      visibleOrder: VISIBLE,
    });
    expect(second.selectedIds).toEqual(new Set([TASK_A, TASK_B, TASK_C]));
    expect(second.selectionAnchorId).toBe(TASK_A);
  });

  it('shrinks the range back toward the anchor when reversing direction', () => {
    const extended = scheduleFocusReducer(
      scheduleFocusReducer(rowFocused(TASK_A), {
        type: 'EXTEND_SELECTION',
        toRowId: TASK_B,
        visibleOrder: VISIBLE,
      }),
      { type: 'EXTEND_SELECTION', toRowId: TASK_C, visibleOrder: VISIBLE },
    );
    const shrunk = scheduleFocusReducer(extended, {
      type: 'EXTEND_SELECTION',
      toRowId: TASK_B,
      visibleOrder: VISIBLE,
    });
    expect(shrunk.selectedIds).toEqual(new Set([TASK_A, TASK_B]));
    expect(shrunk.selectionAnchorId).toBe(TASK_A);
  });

  it('is a no-op when the target row is not in the visible order', () => {
    const focused = rowFocused(TASK_A);
    expect(
      scheduleFocusReducer(focused, {
        type: 'EXTEND_SELECTION',
        toRowId: 'not-visible',
        visibleOrder: VISIBLE,
      }),
    ).toEqual(focused);
  });
});

describe('scheduleFocusReducer — SELECT_IDS (⌘A, #2727, ADR-0776 §1)', () => {
  it('replaces the selection with exactly the given ids, anchored to the focused row', () => {
    const next = scheduleFocusReducer(rowFocused(TASK_B), {
      type: 'SELECT_IDS',
      ids: [TASK_A, TASK_B, TASK_C],
    });
    expect(next.selectedIds).toEqual(new Set([TASK_A, TASK_B, TASK_C]));
    expect(next.selectionAnchorId).toBe(TASK_B);
    expect(next.rowId).toBe(TASK_B);
  });

  it('is a no-op from NoSelection', () => {
    expect(
      scheduleFocusReducer(INITIAL_FOCUS_STATE, { type: 'SELECT_IDS', ids: [TASK_A] }),
    ).toEqual(INITIAL_FOCUS_STATE);
  });

  it('a subsequent SELECT_IDS call replaces the previous selection outright', () => {
    const first = scheduleFocusReducer(rowFocused(TASK_A), {
      type: 'SELECT_IDS',
      ids: [TASK_A, TASK_B],
    });
    const second = scheduleFocusReducer(first, {
      type: 'SELECT_IDS',
      ids: [TASK_A, TASK_B, TASK_C],
    });
    expect(second.selectedIds).toEqual(new Set([TASK_A, TASK_B, TASK_C]));
  });
});
