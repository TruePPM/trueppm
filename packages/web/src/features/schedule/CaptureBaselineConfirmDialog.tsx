import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface CaptureBaselineConfirmDialogProps {
  /** Name of the currently-active baseline, if any — shown so the user knows a
   * re-baseline supersedes but never overwrites it. */
  activeBaselineName?: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "You're about to baseline" educational confirm (#1864). Capturing is not
 * destructive — it adds an immutable snapshot and never overwrites a prior
 * baseline — so this is a plain `role="dialog"` with a primary Confirm, not a
 * destructive `alertdialog`. It exists to explain what a baseline *is* before a
 * first-time PM freezes the plan, and to make re-baselining obviously
 * non-destructive (the previous baseline is kept in history).
 *
 * Self-traps focus (web-rule 206/245): the launching surface disables its own
 * trap while this is open. The visible "Capturing…" button state is the
 * in-flight signal (web-rule 209) for the menu-launched capture path.
 */
export function CaptureBaselineConfirmDialog({
  activeBaselineName,
  isPending,
  onCancel,
  onConfirm,
}: CaptureBaselineConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="capture-baseline-title"
      aria-describedby="capture-baseline-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="capture-baseline-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Capture a baseline?
        </h2>
        <div id="capture-baseline-body" className="text-xs text-neutral-text-secondary">
          <p>
            Baselining freezes the current plan so you can track how far the schedule
            drifts from it. Capturing will:
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            <li>
              Save every task&apos;s current planned start and finish as an{' '}
              <strong className="font-medium text-neutral-text-primary">immutable</strong>{' '}
              snapshot.
            </li>
            <li>
              Become the <strong className="font-medium text-neutral-text-primary">active</strong>{' '}
              baseline used for the planned-vs-current comparison in each task&apos;s drawer.
            </li>
            {activeBaselineName ? (
              <li>
                Supersede the current active baseline (
                <strong className="font-medium text-neutral-text-primary">
                  {activeBaselineName}
                </strong>
                ), which stays in your baseline history — capturing never overwrites a
                previous baseline.
              </li>
            ) : (
              <li>
                Be kept in the project&apos;s baseline history — you can capture more later,
                and re-baselining never overwrites an earlier one.
              </li>
            )}
          </ul>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Capturing…' : 'Capture baseline'}
          </Button>
        </div>
      </div>
    </div>
  );
}
