import { useCallback, useEffect, useRef, useState } from 'react';
import { RECALC_PROMPT_TIMEOUT_MS, type RecalcPromptState } from './recalcPercentPrompt';

type Phase = 'idle' | 'accepting' | 'done' | 'error';

interface Props {
  prompt: RecalcPromptState;
  /** Re-send the edit with an explicit percent_complete. Rejects on API error. */
  onAccept: (percent: number) => Promise<void>;
  /** Dismiss the prompt (Keep — % left unchanged). */
  onDismiss: () => void;
}

/**
 * Inline, non-blocking "Recalc %?" prompt shown on a schedule row after a
 * duration edit under the `confirm` policy (ADR-0151, issue 1254). NEVER a modal:
 * it offers an opt-in proration, auto-dismisses after ~10s (treated as Keep),
 * and pauses that timer while hovered or focused so a reader is never raced.
 * Accepting re-PATCHes percent_complete to the prorated suggestion; dismissing
 * leaves the entered % untouched.
 */
export function RecalcPercentChip({ prompt, onAccept, onDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const pausedRef = useRef(false);
  const { suggestedPercent, oldDuration, newDuration } = prompt;

  // ~10s auto-dismiss (treated as Keep), paused while hovered/focused. Not armed
  // once the user has accepted (accepting/done) or hit an error to retry.
  useEffect(() => {
    if (phase !== 'idle') return;
    let remaining = RECALC_PROMPT_TIMEOUT_MS;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (!pausedRef.current) remaining -= now - last;
      last = now;
      if (remaining <= 0) {
        clearInterval(id);
        onDismiss();
      }
    }, 250);
    return () => clearInterval(id);
  }, [phase, onDismiss]);

  // Brief success confirmation, then unmount.
  useEffect(() => {
    if (phase !== 'done') return;
    const id = setTimeout(onDismiss, 1200);
    return () => clearTimeout(id);
  }, [phase, onDismiss]);

  const handleAccept = useCallback(async () => {
    setPhase('accepting');
    try {
      await onAccept(suggestedPercent);
      setPhase('done');
    } catch {
      setPhase('error');
    }
  }, [onAccept, suggestedPercent]);

  const pause = () => {
    pausedRef.current = true;
  };
  const resume = () => {
    pausedRef.current = false;
  };

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
        <span aria-hidden="true">✓</span>
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
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
      onBlurCapture={resume}
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
        <span aria-hidden="true">↻</span>
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
