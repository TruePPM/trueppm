import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface RemoveFromProgramConfirmDialogProps {
  /** Name of the project being removed from the program. */
  projectName: string;
  /** Name of the program the project is leaving (for the consequence copy). */
  programName: string;
  /** Whether the remove PATCH is in flight — disables the confirm button. */
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Destructive-action confirm for removing a project from a program (#2176,
 * delete-safety rule 266 / #2029/#2054).
 *
 * "Remove" previously fired the unassign PATCH the moment it was clicked, with
 * no confirmation and no statement of what the project loses. Reassigning is
 * reversible (add it back), but the *consequence* is not obvious — the project
 * drops out of the shared backlog, the rollup, and the program schedule — so we
 * name that blast radius before the action rather than after.
 *
 * A real `role="alertdialog"` (not `dialog`) because the action removes the
 * project from three program-level surfaces. Self-traps focus (web-rule
 * 206/245); the launching surface disables its own trap while this is open.
 */
export function RemoveFromProgramConfirmDialog({
  projectName,
  programName,
  isPending,
  onCancel,
  onConfirm,
}: RemoveFromProgramConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="remove-from-program-title"
      aria-describedby="remove-from-program-body"
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
          id="remove-from-program-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Remove “{projectName}” from {programName ? `“${programName}”` : 'this program'}?
        </h2>
        <p id="remove-from-program-body" className="text-xs text-neutral-text-secondary">
          The project leaves the program&rsquo;s shared backlog, rollup, and combined schedule. The
          project itself and its data are untouched — you can add it back to the program at any time.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={isPending}>
            Remove from program
          </Button>
        </div>
      </div>
    </div>
  );
}
