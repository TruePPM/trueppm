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
 * 44px of vertical hit area on a 28px control, painted by nothing (web rules 5 and
 * 253(c), #3446). Shared by both buttons so the two can never drift apart — a pad
 * that is right on Confirm and short on Cancel is the failure this class produces.
 * The geometry, and why it is asymmetric, is explained where the buttons are.
 */
const HIT_PAD_44 =
  "relative before:absolute before:content-[''] before:inset-x-0 before:top-[-5px] before:bottom-[-13px]";

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
 * The #3394 residual — a strip left with the mount focus untouched still expires
 * under the focused Confirm button, dropping a listening screen-reader user to
 * `<body>` — is closed by #3445, and **not** by pausing on the autofocus (which is
 * indistinguishable from never expiring). Every exit that returns the Grid to
 * `deletePhase: 'idle'` without deleting — the dwell expiring, the Cancel button,
 * and Escape — now routes through `GridView`'s single `handleCancelDelete`, which
 * hands focus to the bulk **Delete** button on the following commit (web rule 368,
 * WCAG 2.4.3). It cannot be done synchronously here the way rule 368(b) asks,
 * because the destination does not exist until `deletePhase` is back to `'idle'`
 * and this strip has already unmounted; see rule 368(e).
 *
 * Escape lives on this element rather than on a document listener because the strip
 * is the `alertdialog` and it holds focus, so the keydown bubbles to it — and
 * routing it through `onCancel` is what makes "one exit path, not three" true of
 * the focus handoff as well as of the state transition.
 *
 * Both controls carry a layout-neutral `before:` hit-area pad rather than a literal
 * 44px box (web rules 5 and 253(c), #3446) — see the comment on the buttons.
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
    // `role="alertdialog"` reads as non-interactive to the rule, but Escape is a
    // DIALOG-level binding, not a control's own: it has to fire wherever focus sits
    // inside the strip. Putting it on the two buttons instead would make it work only
    // from the two places the user already has a visible way out. The strip focuses
    // itself on mount, so a keyboard user is inside it by construction and nothing
    // here is mouse-only. Same call, same reasoning, as `BulkEditSheet`.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="alertdialog"
      aria-label={`Confirm deletion of ${count} ${noun}`}
      className="flex items-center gap-3 w-full"
      onKeyDown={(e) => {
        // Escape declines the delete, like every other dialog in the tree — and it
        // goes through the SAME `onCancel` as the button and the dwell, so the
        // rule-368 focus handoff cannot end up wired to two of the three exits
        // (#3445). Guarded on `isDeleting` because both buttons are disabled once
        // the request is in flight: cancelling then would return the toolbar to
        // idle while the delete is still going, which the state machine does not
        // model. `stopPropagation` keeps the grid's own key handling out of it.
        if (e.key !== 'Escape' || isDeleting) return;
        e.stopPropagation();
        onCancel();
      }}
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
          than not pausing (rule 378(c)).

          `HIT_PAD_44` is the rule 5 / 253(c) hit-area pad (#3446). The visible box
          stays 28px because the row it lives in is a fixed 36px and growing it is a
          toolbar height JUMP every time the strip arms — so the 44px comes from a
          transparent `before:` overlay instead, the same device as
          `PendingAcceptanceChip`, `CardPeekButton` and `CalmToolbar`.

          Two geometry decisions are load-bearing and neither is arbitrary.
          **Vertical only** (`inset-x-0`, not `inset-[-8px]`): the two buttons sit
          12px apart (`gap-3`), so a symmetric 8px pad on each would overlap by 4px
          and DOM order — not the user's aim — would decide which one a tap between
          them hits. Width needs no pad anyway; the shorter label, "Cancel", is ~64px
          at `text-xs` + `px-3`, already past 44.
          **Biased downward**: the button is centred in the 36px row, so it can only
          give back 4px upward before it is level with the row's top edge, and
          anything past that is clipped by `GridView`'s `overflow-hidden` root — so
          the remaining 8px is spent downward, into the `ChipStrip` band below. That
          is why `GridView` gives the confirm row `relative z-10`: without a stacking
          context the rows below paint later, win the hit test in the overhang, and
          the pad is decorative. The 8px is borrowed only while an `alertdialog` is
          demanding a decision.

          **The insets are -5/-13, not -4/-12, and the extra pixel is not slop.** An
          absolutely-positioned child resolves its offsets against the PADDING box,
          which excludes this button's 1px border — so -4/-12 measures 4 + 26 + 12 =
          42, and the browser said so: the e2e hit-band scan read 43 and failed. The
          pad is stated in padding-box terms and the +1 each side is the border it
          has to cross. Measured, not derived — which is exactly why that test
          bisects the real hit band instead of reading the class list back.

          **It differs deliberately from the select-all checkbox two rows up**, which
          caps its own pad at 36px rather than 44 — that control sits in the IDLE
          toolbar, which wraps to two lines below `md`, so a 44px overlay there lands
          on whatever wrapped underneath it. The confirm row never wraps and holds
          exactly these two controls, so the same overhang has nothing to collide
          with. Do not "make them consistent" without re-reading both reasons. */}
      <button
        ref={confirmRef}
        type="button"
        onClick={onConfirm}
        disabled={isDeleting}
        className={`flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          bg-semantic-critical-bg border border-semantic-critical/50 text-semantic-critical
          disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 ${HIT_PAD_44}`}
      >
        {isDeleting ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={isDeleting}
        className={`flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 ${HIT_PAD_44}`}
      >
        Cancel
      </button>
      <style>{`@keyframes shrink-bar { from { width: 100% } to { width: 0% } }`}</style>
    </div>
  );
}
