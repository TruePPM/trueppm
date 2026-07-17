import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface SubtreeDeleteConfirmDialogProps {
  /** Name of the summary/phase row being deleted. */
  name: string;
  /** Number of descendant rows that go with it. */
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Destructive confirm for deleting a summary/phase row that carries a WBS
 * subtree (#2029). Build-mode leaf deletes stay confirm-free for speed, but a
 * single Backspace on a phase would otherwise take its whole subtree with it — so
 * this names the blast radius before the delete. Since #2078 the Undo faithfully
 * restores the whole subtree, so this is a "you're moving a lot" heads-up, not a
 * point of no return.
 *
 * A real `role="alertdialog"` (not `dialog`) because the action is far-reaching.
 * Self-traps focus (web-rule 206/245); the launching surface disables its own trap
 * while this is open.
 */
export function SubtreeDeleteConfirmDialog({
  name,
  count,
  onCancel,
  onConfirm,
}: SubtreeDeleteConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  const subtaskLabel = `${count} subtask${count === 1 ? '' : 's'}`;
  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="subtree-delete-title"
      aria-describedby="subtree-delete-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="subtree-delete-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Delete “{name}” and its {subtaskLabel}?
        </h2>
        <p id="subtree-delete-body" className="text-xs text-neutral-text-secondary">
          This removes the row and all {count} nested {count === 1 ? 'row' : 'rows'} beneath it.
          You can undo it — the whole subtree, its dependencies, and assignments come back.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            Delete {count + 1} rows
          </Button>
        </div>
      </div>
    </div>
  );
}
