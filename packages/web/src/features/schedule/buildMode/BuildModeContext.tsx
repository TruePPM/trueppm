import { createContext, useContext, type ReactNode } from 'react';
import type { UseScheduleFocusReturn } from './useScheduleFocus';

export interface BuildModeApi {
  focus: UseScheduleFocusReturn;
  /** Indent the row (Alt+→ from RowFocused, #2727 — not Tab, see ADR-0776 §6). */
  indent: (taskId: string) => void;
  /** Outdent the row (Alt+← from RowFocused, #2727 — not Shift-Tab, see ADR-0776 §6). */
  outdent: (taskId: string) => void;
  /** Insert a sibling row below the current row (Enter from RowFocused). */
  insertBelow: (taskId: string) => void;
  /**
   * The `enterCreatesRow` display preference (#3079). Lives here rather than being
   * threaded through row props because the rows already take their whole authoring
   * vocabulary from this context, and it governs one of those verbs.
   *
   * Optional so a test mock of `BuildModeApi` need not restate it; absent reads as
   * the shipped default (on).
   */
  enterCreatesRow?: boolean;
  /** Insert a sibling row above the current row (Shift+Enter, #2727). */
  insertAbove: (taskId: string) => void;
  /**
   * Insert a child row one level under the current row (⌘/Ctrl+Enter, #2727).
   * The current row becomes a summary as a side effect of gaining a child —
   * `isSummary` is server-derived from having children, not a settable flag.
   */
  insertChild: (taskId: string) => void;
  /**
   * Make the row a milestone — a dated gate that holds no work (#3256).
   *
   * Sends `is_milestone: true` and lets the server zero the duration and set
   * `delivery_mode`. It must NOT send a bare `duration: 0`: the serializer's
   * coupling is one-directional, so that payload lands a zero-duration *work* row
   * and every milestone behaviour keys off `isMilestone`.
   *
   * Refuses on a summary row — a phase's dates roll up from the work inside it,
   * so it cannot be a gate. The refusal is stated, not silent.
   */
  convertToMilestone: (taskId: string) => void;
  /**
   * The reverse: turn a milestone back into work, restoring the estimate it had
   * before the conversion (#3256).
   *
   * The prior estimate is stashed client-side at conversion time. It therefore
   * survives the session, not a reload: `own_estimate` is read-only on the
   * serializer and already owned by the container-shadow lifecycle (#2950), so a
   * durable stash needs a server field and is filed separately. A milestone whose
   * stash is gone converts back at its current duration rather than refusing —
   * being unable to undo is the defect this act exists to remove.
   */
  convertToTask: (taskId: string) => void;
  /**
   * ⌘D / Ctrl+D / the row menu's Duplicate item (#2727, ADR-0776 §2, amending
   * ADR-0066 §Q1): duplicates `taskId` and its full subtree, top-down,
   * remapping each clone's `parent_id` to its newly-created parent's id as it
   * goes. Only the root clone's name gets the "(copy)" suffix; descendants
   * keep their source names. Dependencies are never cloned — including edges
   * *internal* to the duplicated subtree — extending ADR-0066's existing rule
   * uniformly rather than special-casing it away for this richer case. When a
   * multi-row selection is active and includes `taskId`, every top-level
   * selected node (one whose ancestor isn't also selected) is duplicated as
   * its own subtree root in the same operation.
   */
  duplicateSubtree: (taskId: string) => void;
  /** Delete a task. Used by the row menu and the Delete key. */
  deleteTask: (taskId: string) => void;
  /**
   * Backspace on an empty row (#2727): delete it and focus the previous
   * visible row's Name cell with the caret at the end of its text. No-op
   * when there is no previous visible row.
   */
  mergeIntoPreviousRow: (taskId: string) => void;
  /**
   * True for the one task, if any, whose Name cell should focus with the
   * caret at the end of its text rather than the usual select-all — set by
   * `mergeIntoPreviousRow`.
   */
  isCaretAtEndRow: (taskId: string) => boolean;
  /** Marks a task as no longer the caret-at-end target (first keystroke, commit, or rollback). */
  clearCaretAtEndRow: (taskId: string) => void;
  /**
   * True when an indent / outdent / delete mutation is in flight for the
   * given task. Delete is included (#806) so the row gets the in-flight
   * treatment and the context-menu guards in `TaskListRow` fire before the
   * row unmounts on cache invalidation.
   */
  isMutationPending: (taskId: string) => boolean;
  /**
   * True for a task that `insertBelow` just created and whose Name has not
   * been touched yet. The row is created with a non-blank placeholder name
   * (the API rejects a blank one), but the Name cell renders empty for this
   * task so the UX and the double-Enter no-op guard both still read "blank
   * until typed" (#2682 follow-up). Optional — only `ScheduleView`'s real
   * wiring provides it; test mocks of `BuildModeApi` may omit it.
   */
  isPristineNewRow?: (taskId: string) => boolean;
  /** Marks a task as no longer pristine (first keystroke, commit, or rollback). */
  clearPristineNewRow?: (taskId: string) => void;
}

const BuildModeContext = createContext<BuildModeApi | null>(null);

export function BuildModeProvider({
  api,
  children,
}: {
  api: BuildModeApi;
  children: ReactNode;
}) {
  return <BuildModeContext.Provider value={api}>{children}</BuildModeContext.Provider>;
}

/**
 * Returns the build-mode API when a `<BuildModeProvider>` ancestor exists,
 * otherwise null. Components key off the null-check to switch between
 * flag-off (existing) and flag-on (build-mode) rendering paths.
 */
export function useBuildMode(): BuildModeApi | null {
  return useContext(BuildModeContext);
}
