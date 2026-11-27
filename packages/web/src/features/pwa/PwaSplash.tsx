import { LogoMark } from '@/components/Icons';
import { isStandalone } from '@/lib/pwa/displayMode';

/**
 * Branded launch screen for the installed app (ADR-1523 §3, #1425).
 *
 * iOS wants one `apple-touch-startup-image` per device size and orientation, so the
 * launch splash is in-app instead: when the app runs standalone (launched from the
 * Home Screen) the session-restore hold in `RequireAuth` renders this rather than a
 * blank screen. In a browser tab the hold stays blank, as it always was — a tab has
 * the browser's own loading chrome.
 *
 * `role="status"` with a text label so a screen reader announces the restore rather
 * than silence; the spinner is decorative and honors reduced motion.
 */
export function PwaSplash() {
  return (
    <div
      role="status"
      aria-label="Restoring your session"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-navy-700 px-6 text-center text-reversed"
      data-testid="pwa-splash"
    >
      <LogoMark size={64} aria-hidden="true" />
      <div>
        <p className="font-display text-2xl font-semibold">TruePPM</p>
        <p className="mt-1 text-sm text-reversed/80">Scheduling that tells the truth</p>
      </div>
      <span
        aria-hidden="true"
        className="h-6 w-6 rounded-full border-2 border-reversed/30 border-t-reversed motion-safe:animate-spin"
      />
      <p className="font-mono text-xs text-reversed/70">v{__APP_VERSION__} · restoring session</p>
    </div>
  );
}

/**
 * What a session-restore hold renders: the branded splash when installed, nothing
 * in a browser tab (today's behavior).
 */
export function SessionRestoreHold({ standalone = isStandalone() }: { standalone?: boolean }) {
  return standalone ? <PwaSplash /> : null;
}
