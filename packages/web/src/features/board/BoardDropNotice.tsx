/**
 * Scope-injection drop toast (#1140, ADR-0123).
 *
 * An ephemeral, bottom-center notice that fires when a card is dragged into an
 * ACTIVE sprint and creates a pending scope-change (post-activation injection,
 * ADR-0102). It is NOT a new dependency — it reuses the same aria-live + DOM
 * timer pattern the schedule/backlog surfaces use.
 *
 * Tone is NEUTRAL/info, never success-green (rule 149/170): adding a card to a
 * running sprint as *pending* scope is a read-state, not a celebration. The
 * leading glyph is the SAME hollow ○ as `PendingAcceptanceChip` so the toast and
 * the card chip can never drift in tone. Single instance: a new message replaces
 * the prior one and resets the auto-dismiss timer.
 */
import { useEffect, useRef, useState } from 'react';

interface BoardDropNoticeProps {
  /**
   * The message to show. Setting a new non-null value (re)shows the toast and
   * resets the 4s timer; the parent clears it back to null to dismiss early.
   * Pass a `{ key, text }` so two identical drops still re-trigger the toast.
   */
  notice: { key: number; text: string } | null;
}

const AUTO_DISMISS_MS = 4000;

export function BoardDropNotice({ notice }: BoardDropNoticeProps) {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notice) return;
    setText(notice.text);
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Re-run on every new notice (key changes even for identical text).
  }, [notice]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2',
        'max-w-[90vw] rounded-card border border-neutral-border bg-neutral-surface-raised',
        'px-3 py-2 text-sm text-neutral-text-primary shadow-pop',
        'flex items-center gap-2 transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
      {visible && (
        <>
          <span aria-hidden="true" className="leading-none text-neutral-text-secondary">
            ○
          </span>
          <span>{text}</span>
        </>
      )}
    </div>
  );
}
