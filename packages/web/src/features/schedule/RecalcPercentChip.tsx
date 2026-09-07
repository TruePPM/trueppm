import { useCallback, useState } from 'react';
import { RECALC_PROMPT_TIMEOUT_MS, type RecalcPromptState } from './recalcPercentPrompt';
import { CheckIcon, RepeatIcon } from '@/components/Icons';
import { usePausableAutoDismiss } from '@/components/Toast/usePausableAutoDismiss';

type Phase = 'idle' | 'accepting' | 'done' | 'error';

/** How long the "Set to N%" confirmation stays before the chip unmounts. */
const CONFIRM_DWELL_MS = 1200;

interface Props {
  prompt: RecalcPromptState;
  /** Re-send the edit with an explicit percent_complete. Rejects on API error. */
  onAccept: (percent: number) => Promise<void>;
  /** Dismiss the prompt (Keep — % left unchanged). Need not be stable. */
  onDismiss: () => void;
}

/**
 * Inline, non-blocking "Recalc %?" prompt shown on a schedule row after a
 * duration edit under the `confirm` policy (ADR-0151, issue 1254). NEVER a modal:
 * it offers an opt-in proration, auto-dismisses after ~10s (treated as Keep),
 * and pauses that timer while hovered or focused so a reader is never raced.
 * Accepting re-PATCHes percent_complete to the prorated suggestion; dismissing
 * leaves the entered % untouched.
 *
 * Both dwells come from `usePausableAutoDismiss`, which reads `onDismiss` through
 * a ref. Every call site passes an inline arrow, and the previous hand-rolled
 * timers listed that callback in their effect dependencies — so each parent
 * re-render (a task refetch re-renders every row) tore the timer down and re-armed
 * it from zero, and on a busy schedule the prompt never went away on its own.
 */
export function RecalcPercentChip({ prompt, onAccept, onDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const { suggestedPercent, oldDuration, newDuration } = prompt;

  // ~10s auto-dismiss (treated as Keep), paused while hovered or holding focus.
  // Armed only while idle: accepting/done have their own exit below, and an error
  // waits for a retry rather than timing out under the user.
  const { pauseHandlers } = usePausableAutoDismiss({
    active: phase === 'idle',
    durationMs: RECALC_PROMPT_TIMEOUT_MS,
    restartKey: prompt,
    onDismiss,
  });

  // Brief success confirmation, then unmount. No pause handlers are attached to
  // this instance on purpose: the confirmation holds no control, so there is
  // nothing a reader can be raced away from — the hook is used here only for the
  // ref-read of `onDismiss` that makes the dwell survive a parent re-render.
  usePausableAutoDismiss({
    active: phase === 'done',
    durationMs: CONFIRM_DWELL_MS,
    restartKey: prompt,
    onDismiss,
  });

  const handleAccept = useCallback(async () => {
    setPhase('accepting');
    try {
      await onAccept(suggestedPercent);
      setPhase('done');
    } catch {
      setPhase('error');
    }
  }, [onAccept, suggestedPercent]);

  const base =
    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 h-6 text-xs font-medium';

  if (phase === 'done') {
    return (
      <span
        role="status"
        aria-live="polite"
        data-testid="recalc-percent-chip"
        className={`${base} border-semantic-on-track/40 bg-semantic-on-track-bg text-semantic-on-track`}
      >
        <CheckIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
        <span>Set to {suggestedPercent}%</span>
      </span>
    );
  }

  const accepting = phase === 'accepting';
  const errored = phase === 'error';

  return (
    // The chip is a polite live region whose actions live on the inner buttons.
    // The container-level mouse/focus handlers only pause the auto-dismiss timer
    // while the user is reading/interacting, and Escape dismisses — enhancements
    // on top of the real interactive controls, not the primary affordance.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <span
      role="status"
      aria-live="polite"
      data-testid="recalc-percent-chip"
      {...pauseHandlers}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDismiss();
        }
      }}
      className={`${base} ${
        errored
          ? 'border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk'
          : 'border-brand-primary/40 bg-brand-primary-light text-brand-primary'
      }`}
    >
      <button
        type="button"
        disabled={accepting}
        aria-busy={accepting}
        aria-label={
          errored
            ? `Retry recalculating percent complete to ${suggestedPercent}%`
            : `Recalculate percent complete to ${suggestedPercent}%. Duration changed from ${oldDuration} to ${newDuration} days.`
        }
        onClick={(e) => {
          e.stopPropagation();
          void handleAccept();
        }}
        className="inline-flex items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed"
      >
        <RepeatIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
        {accepting ? (
          <span>Recalculating…</span>
        ) : errored ? (
          <span>Couldn&apos;t update — retry</span>
        ) : (
          <span>
            Recalc %? <span className="tabular-nums">→ {suggestedPercent}%</span>
          </span>
        )}
      </button>
      {!accepting && (
        <button
          type="button"
          aria-label="Keep current percent complete"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="inline-flex h-6 w-6 -mr-1 items-center justify-center rounded-full leading-none hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </span>
  );
}
