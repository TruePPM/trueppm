import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { IterationLabelForms } from '@/lib/iterationLabel';

interface MethodologyFlipWarningDialogProps {
  /** Count of the project's existing sprints, all states (issue #2619). */
  count: number;
  itl: IterationLabelForms;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Consent gate on a methodology flip that would hide existing sprint data
 * (issue #2619). WATERFALL hides the DELIVER nav group (`methodologyTabs.ts`),
 * and a flip never touches sprint rows — so without this, a team that already
 * committed to sprints would lose the nav entry with no warning and no signal
 * afterward that the sprints still exist (the `SprintsView` mismatch banner
 * covers the *after* state; this covers the moment before it happens).
 *
 * Not a destructive confirm (`variant="primary"`, not `danger`) — nothing is
 * deleted, only hidden from the nav; the sprints stay reachable by direct URL
 * and via the mismatch banner. `role="alertdialog"` + a focus trap mirror the
 * codebase's other pre-write consent dialogs (`SeedReplaceConfirmDialog`).
 *
 * `pending` is a real phase, not a styling flag (#3298). Confirming disables the
 * very button the user just activated, and a browser blurs a disabled element —
 * so focus lands on `<body>` while an `aria-modal` dialog is still on screen,
 * with the new `Switching…` state announced to nobody. Passing `pending` as
 * `useFocusTrap`'s `focusKey` re-seats focus on the phase change; with both
 * buttons disabled there is no focusable child, so the trap falls back to this
 * container, whose `tabIndex={-1}` + `role="alertdialog"` + `aria-labelledby` /
 * `aria-describedby` re-announce what is happening. This is the multi-state case
 * the hook documents (#1776) — the dialog only became multi-state when it started
 * outliving the confirm click.
 */
export function MethodologyFlipWarningDialog({
  count,
  itl,
  pending,
  onCancel,
  onConfirm,
}: MethodologyFlipWarningDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(
    true,
    () => {
      if (!pending) onCancel();
    },
    pending,
  );
  const noun = count === 1 ? itl.lower : itl.lowerPlural;

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="methodology-flip-title"
      aria-describedby="methodology-flip-body"
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="methodology-flip-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Switch to Waterfall?
        </h2>
        <p id="methodology-flip-body" className="text-xs text-neutral-text-secondary">
          This project has {count} {noun} already committed. Waterfall hides the {itl.lowerPlural}{' '}
          views from the nav — the {itl.lowerPlural} are not deleted and stay reachable by direct
          URL, but no one will see them from the sidebar until you switch back or navigate there
          directly.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? 'Switching…' : 'Switch to Waterfall'}
          </Button>
        </div>
      </div>
    </div>
  );
}
