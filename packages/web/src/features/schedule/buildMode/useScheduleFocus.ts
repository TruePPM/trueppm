import { useReducer, useCallback } from 'react';

/**
 * The three legal focus states for the Schedule list when build-mode is on.
 *
 * - NoSelection: nothing focused. Tab/Shift-Tab fall through to browser default.
 * - RowFocused: a row is selected. Tab=indent, Shift-Tab=outdent, Enter/F2=enter
 *   cell-edit, letter-key=enter Name cell, ArrowUp/Down=move row, Esc=NoSelection.
 * - CellEdit: an editable cell input is focused. Tab=commit + next field,
 *   Shift-Tab=commit + previous field, Enter=commit + back to RowFocused,
 *   Esc=rollback + back to RowFocused.
 *
 * The reducer is the single source of truth for keyboard disambiguation —
 * Tab on a row indents, Tab in cell-edit moves to the next field. Without this
 * machine those two semantics collide.
 */
export type FocusMode = 'NoSelection' | 'RowFocused' | 'CellEdit';

/** The columns that participate in inline-edit Tab traversal, left to right. */
export const EDITABLE_COLUMNS = ['name', 'duration', 'progress'] as const;
export type EditableColumn = (typeof EDITABLE_COLUMNS)[number];

export interface ScheduleFocusState {
  mode: FocusMode;
  /** UUID of the focused task, when mode !== NoSelection. */
  rowId: string | null;
  /** Editable column key, when mode === CellEdit. */
  column: EditableColumn | null;
}

export const INITIAL_FOCUS_STATE: ScheduleFocusState = {
  mode: 'NoSelection',
  rowId: null,
  column: null,
};

export type FocusAction =
  | { type: 'CLEAR' }
  | { type: 'FOCUS_ROW'; rowId: string }
  | { type: 'ENTER_CELL_EDIT'; rowId: string; column: EditableColumn }
  | { type: 'COMMIT_TO_ROW' }
  | { type: 'ROLLBACK_TO_ROW' }
  | { type: 'TAB_FORWARD' }
  | { type: 'TAB_BACKWARD' };

function nextEditableColumn(current: EditableColumn): EditableColumn | null {
  const idx = EDITABLE_COLUMNS.indexOf(current);
  return idx === -1 || idx === EDITABLE_COLUMNS.length - 1
    ? null
    : EDITABLE_COLUMNS[idx + 1];
}

function previousEditableColumn(current: EditableColumn): EditableColumn | null {
  const idx = EDITABLE_COLUMNS.indexOf(current);
  return idx <= 0 ? null : EDITABLE_COLUMNS[idx - 1];
}

export function scheduleFocusReducer(
  state: ScheduleFocusState,
  action: FocusAction,
): ScheduleFocusState {
  switch (action.type) {
    case 'CLEAR':
      return INITIAL_FOCUS_STATE;

    case 'FOCUS_ROW':
      return { mode: 'RowFocused', rowId: action.rowId, column: null };

    case 'ENTER_CELL_EDIT':
      // Illegal to jump to CellEdit without first having a focused row.
      // Callers must FOCUS_ROW first; this guard catches programmatic misuse.
      if (state.mode === 'NoSelection') {
        throw new Error(
          'scheduleFocusReducer: cannot ENTER_CELL_EDIT from NoSelection — must FOCUS_ROW first',
        );
      }
      return {
        mode: 'CellEdit',
        rowId: action.rowId,
        column: action.column,
      };

    case 'COMMIT_TO_ROW':
    case 'ROLLBACK_TO_ROW':
      // Both transitions return to the row that was being edited; only the
      // semantic difference (saved vs reverted) matters to the cell, not to
      // the focus machine itself.
      if (state.mode !== 'CellEdit' || !state.rowId) return state;
      return { mode: 'RowFocused', rowId: state.rowId, column: null };

    case 'TAB_FORWARD':
      if (state.mode === 'CellEdit' && state.column && state.rowId) {
        const next = nextEditableColumn(state.column);
        // Last column → fall back to RowFocused so caller can decide
        // (e.g. wrap to next row's first cell).
        return next
          ? { mode: 'CellEdit', rowId: state.rowId, column: next }
          : { mode: 'RowFocused', rowId: state.rowId, column: null };
      }
      // RowFocused.Tab and NoSelection.Tab are not internal transitions —
      // they trigger external actions (indent, browser focus). Caller handles.
      return state;

    case 'TAB_BACKWARD':
      if (state.mode === 'CellEdit' && state.column && state.rowId) {
        const prev = previousEditableColumn(state.column);
        return prev
          ? { mode: 'CellEdit', rowId: state.rowId, column: prev }
          : { mode: 'RowFocused', rowId: state.rowId, column: null };
      }
      return state;

    default:
      return state;
  }
}

export interface UseScheduleFocusReturn {
  state: ScheduleFocusState;
  focusRow: (rowId: string) => void;
  enterCellEdit: (rowId: string, column: EditableColumn) => void;
  commitToRow: () => void;
  rollbackToRow: () => void;
  tabForward: () => void;
  tabBackward: () => void;
  clear: () => void;
  isCellInEdit: (rowId: string, column: EditableColumn) => boolean;
  isRowFocused: (rowId: string) => boolean;
}

/**
 * Hook wrapper around the reducer. Returns memoized dispatchers and helpers
 * so callers (TaskListRow, EditableCell, BuildModeHintStrip) read identical
 * state without prop-drilling the reducer instance.
 */
export function useScheduleFocus(): UseScheduleFocusReturn {
  const [state, dispatch] = useReducer(scheduleFocusReducer, INITIAL_FOCUS_STATE);

  const focusRow = useCallback((rowId: string) => {
    dispatch({ type: 'FOCUS_ROW', rowId });
  }, []);

  const enterCellEdit = useCallback((rowId: string, column: EditableColumn) => {
    dispatch({ type: 'ENTER_CELL_EDIT', rowId, column });
  }, []);

  const commitToRow = useCallback(() => {
    dispatch({ type: 'COMMIT_TO_ROW' });
  }, []);

  const rollbackToRow = useCallback(() => {
    dispatch({ type: 'ROLLBACK_TO_ROW' });
  }, []);

  const tabForward = useCallback(() => {
    dispatch({ type: 'TAB_FORWARD' });
  }, []);

  const tabBackward = useCallback(() => {
    dispatch({ type: 'TAB_BACKWARD' });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  const isCellInEdit = useCallback(
    (rowId: string, column: EditableColumn) =>
      state.mode === 'CellEdit' &&
      state.rowId === rowId &&
      state.column === column,
    [state],
  );

  const isRowFocused = useCallback(
    (rowId: string) => state.mode !== 'NoSelection' && state.rowId === rowId,
    [state],
  );

  return {
    state,
    focusRow,
    enterCellEdit,
    commitToRow,
    rollbackToRow,
    tabForward,
    tabBackward,
    clear,
    isCellInEdit,
    isRowFocused,
  };
}
