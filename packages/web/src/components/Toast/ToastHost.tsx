import { useEffect, useRef } from 'react';
import { useToastStore } from './toastStore';
import type { ToastItem } from './toastStore';

/**
 * Global toast host (v2 fluidity, ADR-0126; issue 1225) — mounted once in
 * `AppShell`. Renders a bottom-center stack of ink pills (prototype
 * `.toast-wrap`/`.toast`). Each pill rises + fades in via
 * `motion-safe:animate-toast-rise` (rule 180/70) and auto-dismisses after its
 * `durationMs`.
 *
 * Accessibility: the wrap is `role="status" aria-live="polite"` so toasts are
 * announced without stealing focus, and `pointer-events-none` so it never blocks
 * the UI beneath. `shadow-pop` is allowed here — a toast is a pop surface, the
 * standing exception to web rule 1 (no content shadows).
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-[22px] left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2.5"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastPill key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastPill({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.durationMs, dismiss]);

  const dismissNow = () => dismiss(toast.id);
  return (
    <div
      className={[
        'pointer-events-auto flex items-center gap-2.5 rounded-[11px] bg-neutral-text-primary py-3 text-[13.5px] font-medium text-neutral-text-inverse shadow-pop motion-safe:animate-toast-rise',
        // Action toasts trim the right padding to seat the button; plain toasts
        // keep the original symmetric 18px so their layout is pixel-identical.
        toast.action ? 'pl-[18px] pr-3' : 'px-[18px]',
      ].join(' ')}
    >
      {/* Decorative sage check on success/info; the message text carries the
          announcement (aria-hidden). Sage flips with the pill: the pill is the
          inverse of the canvas, so light sage on the light-mode navy pill,
          darker sage on the dark-mode light pill. */}
      {toast.variant !== 'error' && (
        <span aria-hidden="true" className="text-sage-400 dark:text-sage-700">
          ✓
        </span>
      )}
      <span className={toast.action ? 'pr-1' : undefined}>{toast.message}</span>
      {toast.action ? (
        // Inline action (issue 1113 "Undo"). A real focusable button — the host region is
        // aria-live=polite (announces without stealing focus), so keyboard/SR users
        // reach the action via Tab. Runs the action then auto-dismisses the pill; the
        // action's own onClick decides any follow-up confirmation toast.
        <button
          type="button"
          aria-label={toast.action.ariaLabel ?? toast.action.label}
          onClick={() => {
            toast.action?.onClick();
            dismissNow();
          }}
          className="ml-1 min-h-[40px] shrink-0 rounded-[8px] border-l border-neutral-text-inverse/25 pl-3 pr-1.5 font-semibold text-neutral-text-inverse hover:text-sage-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-text-primary dark:hover:text-sage-700"
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}
