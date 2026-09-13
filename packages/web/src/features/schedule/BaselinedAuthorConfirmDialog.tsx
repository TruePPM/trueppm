import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface BaselinedAuthorConfirmDialogProps {
  /**
   * Name of the active baseline, or `null` when the baselines read has not
   * settled. Unresolved is asked about in its own words rather than skipped —
   * "we could not check" is not "there is nothing to warn about" (web rule 392).
   */
  baselineName: string | null;
  /**
   * Whether this reader can capture a baseline (Admin+). The sentence about
   * re-baselining names a destination, and it must be one this reader has —
   * a Member told to "capture a new baseline" is sent looking for a menu row
   * that is not there.
   */
  canCaptureBaseline: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Read → Author on a baselined plan (#3748).
 *
 * Asked once per active baseline, not on every switch: a PM works the plan
 * daily, and a confirm that fires on each toggle becomes a click-through reflex
 * that says nothing by the third time. What it has to land is the one fact the
 * chip cannot — that edits from here on are measured against an agreed copy of
 * the plan, and that the baseline itself stays as it was.
 *
 * Deliberately two buttons. "Take a new baseline / keep this one" is the
 * changeset exit (#3150), and offering re-baseline here, before a single edit
 * exists, would make it the path of least resistance for turning variance
 * green. The sentence about re-baselining points at the act; it does not
 * perform it.
 *
 * The copy avoids "variance" on purpose: a contributor with edit rights reads
 * this too, and "differences from it" says the same thing without the term.
 *
 * Non-destructive, so `role="dialog"` rather than `alertdialog`, with the
 * explanation bound to the dialog itself (web rule 380).
 */
export function BaselinedAuthorConfirmDialog({
  baselineName,
  canCaptureBaseline,
  onCancel,
  onConfirm,
}: BaselinedAuthorConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  const known = baselineName !== null;
  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="baselined-author-title"
      aria-describedby="baselined-author-body"
      tabIndex={-1}
      data-testid="baselined-author-confirm"
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
          id="baselined-author-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          {known ? 'This plan has a baseline' : 'This plan may have a baseline'}
        </h2>
        <div
          id="baselined-author-body"
          className="flex flex-col gap-2 text-xs text-neutral-text-secondary"
        >
          <p>
            {known ? (
              <>
                <strong className="font-medium text-neutral-text-primary">{baselineName}</strong> is
                the saved copy of this plan that progress is measured against.
              </>
            ) : (
              <>We couldn&apos;t check whether this plan has a baseline.</>
            )}{' '}
            Changes you make in Author mode will show as differences from it. The baseline itself is
            not changed.
          </p>
          <p>
            {canCaptureBaseline ? (
              <>
                If these changes are a re-agreed plan, capture a new baseline from{' '}
                <strong className="font-medium text-neutral-text-primary">
                  Project actions → Capture baseline
                </strong>{' '}
                once you have finished editing.
              </>
            ) : (
              <>
                If these changes are a re-agreed plan, ask a project admin to capture a new baseline
                once you have finished editing.
              </>
            )}
          </p>
          {known && <p>You won&apos;t be asked again for this baseline.</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Stay in Read
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            Switch to Author
          </Button>
        </div>
      </div>
    </div>
  );
}
