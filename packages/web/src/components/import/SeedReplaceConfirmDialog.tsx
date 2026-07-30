import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { SeedReplaceConflict } from '@/hooks/useProgramSeedIo';

interface SeedReplaceConfirmDialogProps {
  /** The colliding program, as the server described it in the 409 (ADR-0726 §1). */
  conflict: SeedReplaceConflict;
  onCancel: () => void;
  /** Re-submits the same file with `replace` + the compare-and-swap token. */
  onConfirm: () => void;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Turn the seed importer's `409` refusal into a consent question (#2581).
 *
 * The server refuses a re-import onto a live slug rather than replacing it
 * silently, and the refusal is the *only* place the operator is told what the
 * replacement would cost — so this renders the conflict's counts rather than a
 * generic "are you sure". The recoverability sentence is deliberately asymmetric
 * because the outcome is: the projects are soft-deleted and restorable
 * individually from Trash, while the program shell has no Trash of its own
 * (ADR-0726 §3, #2587). Promising more than that would be the second half of the
 * defect this dialog exists to close.
 *
 * A real `role="alertdialog"` because the action destroys data, and it self-traps
 * focus (web-rule 206/245) — the launching surface disables its own trap while
 * this is open. Cancel precedes the destructive action in the DOM so the trap's
 * initial focus lands on the safe choice.
 */
export function SeedReplaceConfirmDialog({
  conflict,
  onCancel,
  onConfirm,
}: SeedReplaceConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="seed-replace-title"
      aria-describedby="seed-replace-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="seed-replace-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Replace “{conflict.name}”?
        </h2>
        <div id="seed-replace-body" className="flex flex-col gap-2 text-xs text-neutral-text-secondary">
          <p>
            A program you own already uses the code{' '}
            <span className="tppm-mono text-neutral-text-primary">{conflict.code}</span>, with{' '}
            {plural(conflict.project_count, 'project')} and {plural(conflict.task_count, 'task')}.
            Importing this file replaces it.
          </p>
          <p>
            Its projects move to Trash and can be restored individually as standalone projects. The
            program itself is not recoverable.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            Replace program
          </Button>
        </div>
      </div>
    </div>
  );
}
