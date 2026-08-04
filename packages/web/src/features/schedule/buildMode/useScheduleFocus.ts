import { useReducer, useCallback } from 'react';

/**
 * The three legal focus states for the Schedule list when build-mode is on.
 *
 * - NoSelection: nothing focused. Tab/Shift-Tab fall through to browser default.
 * - RowFocused: a row is selected. Alt+→=indent, Alt+←=outdent (#2727, ADR-0776
 *   §6 — NOT Tab/Shift-Tab, which would reproduce the WCAG 2.1.2 keyboard trap
 *   #2192 already fixed once in OutlineMode.tsx), Enter/F2=enter cell-edit,
 *   letter-key=enter Name cell, ArrowUp/Down=move row, Esc=NoSelection.
 * - CellEdit: an editable cell input is focused. Tab=commit + next field,
 *   Shift-Tab=commit + previous field, Enter=commit + back to RowFocused,
 *   Esc=rollback + back to RowFocused.
 *
 * The reducer is the single source of truth for keyboard disambiguation —
 * Tab falls through to native focus traversal outside cell-edit, and moves to
 * the next field inside it. Without this machine those two contexts collide.
 */
export type FocusMode = 'NoSelection' | 'RowFocused' | 'CellEdit';

/** The columns that participate in inline-edit Tab traversal, left to right. */
export const EDITABLE_COLUMNS = ['name', 'duration', 'progress'] as const;
export type EditableColumn = (typeof EDITABLE_COLUMNS)[number];

export interface ScheduleFocusState {
  mode: FocusMode;
  /**
   * UUID of the focused task, when mode !== NoSelection. During an active
   * multi-row selection this tracks the *moving edge* — the row that last
   * received DOM focus — not the anchor (see `selectionAnchorId`).
   */
  rowId: string | null;
  /** Editable column key, when mode === CellEdit. */
  column: EditableColumn | null;
  /**
   * The full set of selected row ids (#2727, ADR-0776 §1) — null when no
   * multi-row selection is active (the single `rowId` is "the selection" in
   * that case). Populated by `EXTEND_SELECTION` (Shift+↑/↓) and `SELECT_IDS`
   * (⌘A). Structural keys (indent/outdent, Backspace/Delete) act on every id
   * in this set when it is non-null.
   */
  selectedIds: Set<string> | null;
  /**
   * The row a multi-row selection started from — fixed for the lifetime of
   * the selection, unlike `rowId` which moves with Shift+↑/↓. Null whenever
   * `selectedIds` is null.
   */
  selectionAnchorId: string | null;
}

export const INITIAL_FOCUS_STATE: ScheduleFocusState = {
  mode: 'NoSelection',
  rowId: null,
  column: null,
  selectedIds: null,
  selectionAnchorId: null,
};

export type FocusAction =
  | { type: 'CLEAR' }
  | { type: 'FOCUS_ROW'; rowId: string }
  | { type: 'ENTER_CELL_EDIT'; rowId: string; column: EditableColumn }
  | { type: 'COMMIT_TO_ROW' }
  | { type: 'ROLLBACK_TO_ROW' }
  | { type: 'TAB_FORWARD' }
  | { type: 'TAB_BACKWARD' }
  /**
   * Shift+↑/↓ (#2727): extend/shrink a contiguous selection from the anchor
   * (state.selectionAnchorId, or state.rowId the first time) through
   * `toRowId`, computed against `visibleOrder` (the current flattened,
   * visible row order — the caller supplies it since the reducer has no
   * access to the task tree).
   */
  | { type: 'EXTEND_SELECTION'; toRowId: string; visibleOrder: string[] }
  /**
   * ⌘A (#2727): replace the selection outright with the given id list —
   * "every sibling" on the first press, "the whole visible tree" on the
   * second (TaskListRow decides which set to pass; the reducer just stores
   * it). The currently focused row becomes the anchor.
   */
  | { type: 'SELECT_IDS'; ids: string[] };

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

/**
 * Move the edit cursor to the adjacent editable column.
 *
 * Running off either end falls back to `RowFocused` rather than staying in
 * `CellEdit`, so the caller can decide what happens next (e.g. wrap to the next
 * row's first cell). Anything that is not an active cell edit is returned
 * unchanged — Tab outside `CellEdit` is not this machine's transition.
 */
function stepEditColumn(
  state: ScheduleFocusState,
  step: (current: EditableColumn) => EditableColumn | null,
): ScheduleFocusState {
  if (state.mode !== 'CellEdit' || !state.column || !state.rowId) return state;
  const target = step(state.column);
  return target
    ? { mode: 'CellEdit', rowId: state.rowId, column: target, selectedIds: null, selectionAnchorId: null }
    : { mode: 'RowFocused', rowId: state.rowId, column: null, selectedIds: null, selectionAnchorId: null };
}

export function scheduleFocusReducer(
  state: ScheduleFocusState,
  action: FocusAction,
): ScheduleFocusState {
  switch (action.type) {
    case 'CLEAR':
      return INITIAL_FOCUS_STATE;

    case 'FOCUS_ROW':
      // A plain row focus (click, unmodified arrow move) always collapses
      // any active multi-row selection back to this single row — standard
      // list/grid selection UX, and how a user "escapes" a selection short
      // of Esc.
      return {
        mode: 'RowFocused',
        rowId: action.rowId,
        column: null,
        selectedIds: null,
        selectionAnchorId: null,
      };

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
        selectedIds: null,
        selectionAnchorId: null,
      };

    case 'COMMIT_TO_ROW':
    case 'ROLLBACK_TO_ROW':
      // Both transitions return to the row that was being edited; only the
      // semantic difference (saved vs reverted) matters to the cell, not to
      // the focus machine itself.
      if (state.mode !== 'CellEdit' || !state.rowId) return state;
      return {
        mode: 'RowFocused',
        rowId: state.rowId,
        column: null,
        selectedIds: null,
        selectionAnchorId: null,
      };

    case 'EXTEND_SELECTION': {
      // Only meaningful from an already-focused row; a NoSelection Shift+↑/↓
      // has nothing to extend from.
      if (state.mode === 'NoSelection' || !state.rowId) return state;
      const { toRowId, visibleOrder } = action;
      const anchorId = state.selectionAnchorId ?? state.rowId;
      const anchorIdx = visibleOrder.indexOf(anchorId);
      const toIdx = visibleOrder.indexOf(toRowId);
      if (anchorIdx === -1 || toIdx === -1) return state;
      const [lo, hi] = anchorIdx <= toIdx ? [anchorIdx, toIdx] : [toIdx, anchorIdx];
      return {
        mode: 'RowFocused',
        rowId: toRowId,
        column: null,
        selectedIds: new Set(visibleOrder.slice(lo, hi + 1)),
        selectionAnchorId: anchorId,
      };
    }

    case 'SELECT_IDS': {
      if (state.mode === 'NoSelection' || !state.rowId) return state;
      return {
        mode: 'RowFocused',
        rowId: state.rowId,
        column: null,
        selectedIds: new Set(action.ids),
        selectionAnchorId: state.rowId,
      };
    }

    // Both Tab directions are the same transition with a different step
    // function. RowFocused.Tab and NoSelection.Tab are not internal
    // transitions — they trigger external actions (indent, browser focus) and
    // the caller handles them, which is why both fall through unchanged.
    case 'TAB_FORWARD':
      return stepEditColumn(state, nextEditableColumn);

    case 'TAB_BACKWARD':
      return stepEditColumn(state, previousEditableColumn);

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
  /** Shift+↑/↓ (#2727): extend/shrink the selection to `toRowId`. */
  extendSelection: (toRowId: string, visibleOrder: string[]) => void;
  /** ⌘A (#2727): replace the selection with exactly `ids`. */
  selectIds: (ids: string[]) => void;
  /**
   * True when `rowId` is part of the current selection — every id in
   * `selectedIds` when a multi-row selection is active, otherwise just the
   * single focused row (same as `isRowFocused`). The single predicate a row
   * component needs for its "am I highlighted" styling.
   */
  isRowSelected: (rowId: string) => boolean;
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

  const extendSelection = useCallback((toRowId: string, visibleOrder: string[]) => {
    dispatch({ type: 'EXTEND_SELECTION', toRowId, visibleOrder });
  }, []);

  const selectIds = useCallback((ids: string[]) => {
    dispatch({ type: 'SELECT_IDS', ids });
  }, []);

  const isRowSelected = useCallback(
    (rowId: string) => (state.selectedIds ? state.selectedIds.has(rowId) : isRowFocused(rowId)),
    [state, isRowFocused],
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
    extendSelection,
    selectIds,
    isRowSelected,
  };
}
