/**
 * Shared editable-dialog/drawer commit/discard primitives (web-rule 217).
 *
 * Compose these on any surface that edits existing information or collects new
 * information so the Save/Cancel + dirty-state + unsaved-changes-guard contract
 * is inherited rather than re-decided:
 *  - `useDirtyDraft`          — draft/baseline/dirty state + revert + re-snapshot
 *  - `DialogFooter`           — Save (primary) + Cancel (secondary) footer
 *  - `useUnsavedChangesGuard` — the dismiss-guard decision + prompt state
 *  - `UnsavedChangesDialog`   — the focus-trapped discard prompt
 */
export { useDirtyDraft, type DirtyDraft } from './useDirtyDraft';
export { DialogFooter, type DialogFooterProps } from './DialogFooter';
export {
  useUnsavedChangesGuard,
  type UnsavedChangesGuard,
  type UseUnsavedChangesGuardOptions,
} from './useUnsavedChangesGuard';
export { UnsavedChangesDialog, type UnsavedChangesDialogProps } from './UnsavedChangesDialog';
export { UnsavedDot } from './UnsavedDot';
