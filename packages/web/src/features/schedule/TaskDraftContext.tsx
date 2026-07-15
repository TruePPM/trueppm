import { createContext, useContext } from 'react';

/**
 * The three-point estimate slice of the task drawer's deferred draft (#1985).
 * String-valued because the inputs are `<input type="number">` whose empty state
 * is `''` (→ `null` on save); the drawer maps these into the batched PATCH.
 */
export interface TaskEstimateDraft {
  optimistic: string;
  mostLikely: string;
  pessimistic: string;
}

/**
 * Binding a registry section opts into to stage its edits in the drawer's
 * Save/Cancel draft instead of committing immediately (#1985, ADR-0439).
 *
 * This is deliberately a **separate React context**, NOT a field on
 * `DrawerSectionProps`: a section that never calls `useTaskDraft()` is
 * byte-for-byte unaffected, so the `DrawerSectionProps` contract Enterprise
 * registers against stays frozen. The drawer supplies the binding around its
 * section subtree; the full-page `TaskDetailPage` (no Save bar) supplies none,
 * so `useTaskDraft()` returns `null` there and the section falls back to its
 * immediate-mutation behavior.
 */
export interface TaskDraftBinding {
  /**
   * The task the binding is for. A consumer MUST check `binding.taskId === its
   * task.id` before binding: during a swap-while-dirty the drawer keeps
   * rendering the current task while the host selection points elsewhere, so
   * the id guard stops a section from binding to the wrong task.
   */
  taskId: string;
  /** Current staged estimate values (the drawer draft's estimate slice). */
  values: TaskEstimateDraft;
  /** Per-field dirty flags — drive the per-field unsaved "•" markers. */
  changed: Record<keyof TaskEstimateDraft, boolean>;
  /** Stage a field edit into the draft (no server write until Save). */
  setField: (key: keyof TaskEstimateDraft, value: string) => void;
  /**
   * Re-baseline a single estimate field to a server-applied value without
   * touching the rest of the draft — used when an immediate side-write (e.g.
   * accepting a velocity suggestion, which PATCHes `most_likely` directly) must
   * be reflected in the staged input without spuriously marking it dirty.
   */
  commitField: (key: keyof TaskEstimateDraft, value: string) => void;
}

const TaskDraftContext = createContext<TaskDraftBinding | null>(null);

export const TaskDraftProvider = TaskDraftContext.Provider;

/** Read the drawer's estimate draft binding, or `null` outside a staged host. */
export function useTaskDraft(): TaskDraftBinding | null {
  return useContext(TaskDraftContext);
}
