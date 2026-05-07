import { describe, expect, it } from 'vitest';
import {
  EDITABLE_COLUMNS,
  INITIAL_FOCUS_STATE,
  scheduleFocusReducer,
} from './useScheduleFocus';

const TASK_A = 'task-a';
const TASK_B = 'task-b';

describe('scheduleFocusReducer — initial state', () => {
  it('starts in NoSelection with no row or column', () => {
    expect(INITIAL_FOCUS_STATE).toEqual({
      mode: 'NoSelection',
      rowId: null,
      column: null,
    });
  });
});

describe('scheduleFocusReducer — FOCUS_ROW', () => {
  it('moves NoSelection → RowFocused', () => {
    const next = scheduleFocusReducer(INITIAL_FOCUS_STATE, {
      type: 'FOCUS_ROW',
      rowId: TASK_A,
    });
    expect(next).toEqual({ mode: 'RowFocused', rowId: TASK_A, column: null });
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
    expect(editing).toEqual({
      mode: 'CellEdit',
      rowId: TASK_A,
      column: 'name',
    });
  });

  it('moves between cells in CellEdit by re-entering with a new column', () => {
    const editing = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: 'name' },
      { type: 'ENTER_CELL_EDIT', rowId: TASK_A, column: 'duration' },
    );
    expect(editing.column).toBe('duration');
  });
});

describe('scheduleFocusReducer — COMMIT_TO_ROW / ROLLBACK_TO_ROW', () => {
  it('returns CellEdit → RowFocused on commit', () => {
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: 'name' },
      { type: 'COMMIT_TO_ROW' },
    );
    expect(next).toEqual({ mode: 'RowFocused', rowId: TASK_A, column: null });
  });

  it('returns CellEdit → RowFocused on rollback (semantic distinction handled by caller)', () => {
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: 'name' },
      { type: 'ROLLBACK_TO_ROW' },
    );
    expect(next).toEqual({ mode: 'RowFocused', rowId: TASK_A, column: null });
  });

  it('is a no-op outside CellEdit', () => {
    const focused = { mode: 'RowFocused' as const, rowId: TASK_A, column: null };
    expect(
      scheduleFocusReducer(focused, { type: 'COMMIT_TO_ROW' }),
    ).toEqual(focused);
    expect(scheduleFocusReducer(INITIAL_FOCUS_STATE, { type: 'ROLLBACK_TO_ROW' })).toEqual(
      INITIAL_FOCUS_STATE,
    );
  });

  it('rollback returns to the same row that was being edited (never NoSelection)', () => {
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: 'name' },
      { type: 'ROLLBACK_TO_ROW' },
    );
    expect(next.rowId).toBe(TASK_A);
  });
});

describe('scheduleFocusReducer — TAB_FORWARD in CellEdit', () => {
  it('advances to the next editable column', () => {
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: 'name' },
      { type: 'TAB_FORWARD' },
    );
    expect(next.column).toBe('duration');
  });

  it('falls back to RowFocused on the last column (caller wraps)', () => {
    const last = EDITABLE_COLUMNS[EDITABLE_COLUMNS.length - 1];
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: last },
      { type: 'TAB_FORWARD' },
    );
    expect(next).toEqual({ mode: 'RowFocused', rowId: TASK_A, column: null });
  });

  it('is a no-op in RowFocused (Tab=indent is handled externally)', () => {
    const focused = { mode: 'RowFocused' as const, rowId: TASK_A, column: null };
    expect(
      scheduleFocusReducer(focused, { type: 'TAB_FORWARD' }),
    ).toEqual(focused);
  });

  it('is a no-op in NoSelection (browser default Tab applies)', () => {
    expect(
      scheduleFocusReducer(INITIAL_FOCUS_STATE, { type: 'TAB_FORWARD' }),
    ).toEqual(INITIAL_FOCUS_STATE);
  });
});

describe('scheduleFocusReducer — TAB_BACKWARD in CellEdit', () => {
  it('moves to the previous editable column', () => {
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: 'duration' },
      { type: 'TAB_BACKWARD' },
    );
    expect(next.column).toBe('name');
  });

  it('falls back to RowFocused on the first column', () => {
    const first = EDITABLE_COLUMNS[0];
    const next = scheduleFocusReducer(
      { mode: 'CellEdit', rowId: TASK_A, column: first },
      { type: 'TAB_BACKWARD' },
    );
    expect(next).toEqual({ mode: 'RowFocused', rowId: TASK_A, column: null });
  });
});

describe('scheduleFocusReducer — CLEAR', () => {
  it('returns to NoSelection from any state', () => {
    expect(
      scheduleFocusReducer(
        { mode: 'CellEdit', rowId: TASK_A, column: 'name' },
        { type: 'CLEAR' },
      ),
    ).toEqual(INITIAL_FOCUS_STATE);
    expect(
      scheduleFocusReducer(
        { mode: 'RowFocused', rowId: TASK_A, column: null },
        { type: 'CLEAR' },
      ),
    ).toEqual(INITIAL_FOCUS_STATE);
  });
});

describe('scheduleFocusReducer — Tab disambiguation invariant (the central guarantee)', () => {
  it('Tab in RowFocused does not change focus state (caller fires indent)', () => {
    const focused = { mode: 'RowFocused' as const, rowId: TASK_A, column: null };
    const next = scheduleFocusReducer(focused, { type: 'TAB_FORWARD' });
    expect(next).toEqual(focused);
  });

  it('Tab in CellEdit advances column (caller does not fire indent)', () => {
    const editing = { mode: 'CellEdit' as const, rowId: TASK_A, column: 'name' as const };
    const next = scheduleFocusReducer(editing, { type: 'TAB_FORWARD' });
    expect(next.mode).toBe('CellEdit');
    expect(next.column).toBe('duration');
  });
});
