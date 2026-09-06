import { useEffect, useRef, useState } from 'react';
import { usePausableAutoDismiss } from '@/components/Toast/usePausableAutoDismiss';

interface ConfirmDeleteStripProps {
  count: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const DWELL_MS = 5000;

/**
 * Inline confirm strip for bulk-delete in Flat / Grouped modes.
 *
 * Auto-cancels after 5 s, focuses Confirm on mount, and renders a shrink animation
 * to communicate the window. The dwell is **pausable** (web rule 378, WCAG 2.2.1 /
 * 2.4.3): it stops while the strip is hovered or holds focus the user moved there.
 *
 * The mount autofocus is deliberately **outside** the pause (#3394). Every other
 * surface on `usePausableAutoDismiss` pauses on any focus-within, but this one
 * focuses itself, so that rule would read its own autofocus as engagement and the
 * strip would never expire — and here expiry is the *safe* direction, because the
 * timeout **declines** the delete. So the hook is given the autofocus through
 * `runWithoutPausing`, which suppresses the pause for exactly that dispatch: an
 * abandoned strip still cancels itself, and a strip the user has actually touched
 * (hover, or a `focusin` they caused by tabbing to Cancel) does not.
 *
 * Residual, stated rather than hidden: a strip left with the mount focus untouched
 * still expires under the focused Confirm button, so a screen-reader user who is
 * only *listening* — never moving focus or the pointer — can still lose it at 5 s
 * and drop focus to `<body>`. Pausing on that is not distinguishable from pausing
 * forever; the remedy is handing focus somewhere on auto-cancel (web rule 368),
 * which is #3445, not this change.
 */
export function ConfirmDeleteStrip({ count, isDeleting, onConfirm, onCancel }: ConfirmDeleteStripProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // `active: !isDeleting` carries the "no countdown while the delete is in flight"
  // rule that the bare timer had. The flag-clearing half of `active` is inert here:
  // `GridView` returns `deletePhase` to 'idle' on BOTH success and error, so the
  // strip always unmounts rather than coming back from `isDeleting` with stale
  // hover state.
  const { paused, pauseHandlers, runWithoutPausing } = usePausableAutoDismiss({
    active: !isDeleting,
    durationMs: DWELL_MS,
    restartKey: count,
    onDismiss: onCancel,
  });

  useEffect(() => {
    runWithoutPausing(() => confirmRef.current?.focus());
  }, [runWithoutPausing]);

  // Deliberately NOT gated on `prefers-reduced-motion`, against the tree's usual
  // `motion-safe:` habit (ux-review). The bar is no longer decoration — it is the only
  // feedback that the countdown stopped, so suppressing it under reduced-motion would
  // remove the pause indicator from exactly the users most likely to need the pause.
  // It is a determinate progress indicator, which is the shape reduced-motion exempts.
  //
  // The hook restarts the FULL dwell on resume rather than resuming a remainder, so
  // the bar has to restart with it: a bar that picks up at 40% promises a deadline
  // three seconds earlier than the timer will actually fire, which is the same class
  // of lie as a bar that keeps draining while paused. Remounting via `key` is the
  // only way to restart a CSS animation from the start.
  const [runId, setRunId] = useState(0);
  const wasPaused = useRef(false);
  useEffect(() => {
    if (wasPaused.current && !paused) setRunId((n) => n + 1);
    wasPaused.current = paused;
  }, [paused]);

  const noun = `task${count !== 1 ? 's' : ''}`;

  return (
    <div
      role="alertdialog"
      aria-label={`Confirm deletion of ${count} ${noun}`}
      className="flex items-center gap-3 w-full"
      {...pauseHandlers}
    >
      <span className="flex-1 min-w-0">
        <span className="text-xs text-neutral-text-primary">Delete {count} {noun}?</span>
        {/* Bulk delete is now faithfully reversible (#2078): the success toast offers
            an Undo that restores each task's full subtree/deps/assignments. */}
        <span className="ml-1.5 text-xs text-neutral-text-secondary">You can undo this.</span>
        {!isDeleting && (
          <span aria-hidden="true" className="block h-0.5 mt-0.5 rounded-full bg-neutral-surface-sunken overflow-hidden">
            <span
              key={runId}
              data-testid="confirm-delete-shrink-bar"
              data-paused={paused ? 'true' : 'false'}
              className="block h-full rounded-full bg-semantic-critical"
              style={{
                animation: `shrink-bar ${DWELL_MS}ms linear forwards`,
                animationPlayState: paused ? 'paused' : 'running',
              }}
            />
          </span>
        )}
      </span>
      {/* Standalone buttons use focus: (not focus-visible:) so the ring shows on
          pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7). The ring
          is load-bearing here, not decoration — focus is now a MODE that stops the
          countdown, and pausing something the user cannot see they paused is worse
          than not pausing (rule 378(c)). */}
      <button
        ref={confirmRef}
        type="button"
        onClick={onConfirm}
        disabled={isDeleting}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          bg-semantic-critical-bg border border-semantic-critical/50 text-semantic-critical
          disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1"
      >
        {isDeleting ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={isDeleting}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1"
      >
        Cancel
      </button>
      <style>{`@keyframes shrink-bar { from { width: 100% } to { width: 0% } }`}</style>
    </div>
  );
}
