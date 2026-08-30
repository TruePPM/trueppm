import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface CommitPlanConfirmDialogProps {
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "You're about to commit the plan" confirm (#3129, UX-REVIEW §4).
 *
 * `role="dialog"`, not `alertdialog`: committing is consequential but not destructive
 * — it destroys nothing, and authoring continues afterwards. What it is, is **one-way**,
 * and that is the thing this sheet exists to say before a PM clicks once.
 *
 * Three claims in the body, and each is a description of behavior that ships today
 * rather than a promise:
 *
 * 1. *Baseline v1 is captured, calendar frozen.* `commit_project()` creates it in the
 *    same transaction as the lifecycle flip, snapshotting the working calendar **by
 *    value** so a later calendar edit changes variance rather than silently moving the
 *    thing variance is measured from (ADR-0845).
 * 2. *The project joins the aggregates.* A draft is held out of program rollup,
 *    portfolio health, search, My Work and the notification fan-out (#3128), so
 *    committing is what makes it visible to everyone else.
 * 3. *Authoring becomes amending.* This is the half UX-REVIEW §4 insists on, because it
 *    is what makes the door one-way rather than a save — and it is **live**, not
 *    forthcoming: `amend.is_amendable()` keys on `lifecycle == ACTIVE`, and
 *    `TaskViewSet.perform_update` already records the reason into plan history and
 *    calls `notify_amend` on a committed project. #3150 adds the client prompt that
 *    collects the reason; the mode change itself is real now.
 *
 * **What this sheet must never say:** that committing tells the team. It does not.
 * `commit_project()` writes no notification row and fires no `on_commit` hook — the
 * response field that asserted otherwise was renamed in #3129. People are told when
 * their work later *moves* (`notify_amend`), which is what bullet 3 says and all it
 * says.
 *
 * **And what it must never offer:** a re-baseline control or a "keep v1, let variance
 * stand" exit. #3150 owns the second exit, and UX-REVIEW §4's point is that a product
 * offering only re-baseline teaches people to launder slip.
 *
 * Self-traps focus (web-rule 206/245). Cancel precedes Commit in DOM order and takes
 * initial focus — never autofocus a one-way action.
 */
export function CommitPlanConfirmDialog({
  isPending,
  onCancel,
  onConfirm,
}: CommitPlanConfirmDialogProps) {
  // Esc closes via the trap's own handler, but only when no request is in flight —
  // dismissing the sheet mid-POST would leave the user with no signal about an
  // irreversible write they can no longer see the result of.
  const trapRef = useFocusTrap<HTMLDivElement>(true, () => {
    if (!isPending) onCancel();
  });
  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="commit-plan-title"
      aria-describedby="commit-plan-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="commit-plan-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Commit this plan?
        </h2>
        <div id="commit-plan-body" className="text-xs text-neutral-text-secondary">
          <p>Committing does three things:</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            <li>
              Captures{' '}
              <strong className="font-medium text-neutral-text-primary">Baseline v1</strong> — a
              frozen copy of every task&apos;s dates, and the working calendar they were computed
              against. This becomes the anchor every variance number is measured from.
            </li>
            <li>
              Joins the project to program rollup, portfolio health, search and My Work, which a
              draft is held out of.
            </li>
            <li>
              Changes what editing means. Authoring becomes{' '}
              <strong className="font-medium text-neutral-text-primary">amending</strong>: from here
              on a structural edit carries a reason into plan history and tells the people whose
              work moved.
            </li>
          </ul>
          <p className="mt-3">
            You can keep editing. You{' '}
            <strong className="font-medium text-neutral-text-primary">cannot un-commit</strong> — a
            plan is committed once.
          </p>
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Committing…' : 'Commit plan'}
          </Button>
        </div>
      </div>
    </div>
  );
}
