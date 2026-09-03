import { useEffect, useRef, useState } from 'react';
import { useRouteError } from 'react-router';
import { WarningIcon } from '@/components/Icons';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { getPendingWriteCount } from '@/hooks/useSyncStatus';
import { reportError } from '@/lib/telemetry';

/**
 * True when the error is a failed dynamic `import()` of a route chunk — the most
 * common route failure in production: a stale module graph right after a deploy,
 * an offline user, or a transient CDN blip. Vite/Rollup phrase this a few ways
 * ("Failed to fetch dynamically imported module", "error loading dynamically
 * imported module", "Loading chunk N failed"), so match the family loosely.
 */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /dynamically imported module|loading chunk .* failed|failed to fetch/i.test(message);
}

/** Which recovery action the user asked for; both leave the current document. */
type RecoveryAction = 'reload' | 'home';

/** Performs the recovery for real. Every path here discards in-memory state. */
function performRecovery(action: RecoveryAction): void {
  if (action === 'reload') {
    window.location.reload();
  } else {
    window.location.href = '/';
  }
}

/**
 * Interrupting confirmation shown when a recovery action would throw away queued
 * offline writes (#2834).
 *
 * `PendingWritesGuard`'s `beforeunload` prompt is the app's normal protection,
 * but it is mounted *inside* `AppShell` — so on the one screen whose whole job is
 * to offer a reload, it may already be gone. This dialog is the second,
 * independent gate: the boundary asks the write queue itself rather than trusting
 * a guard that the same crash may have unmounted.
 *
 * `role="alertdialog"` (the action interrupts), and it owns its own
 * `useFocusTrap` — it is mounted bare on the error surface with no parent modal
 * to contain focus (rule 206/245). The safe action ("Stay on this page") is first
 * in the DOM so the trap's default seat is never the destructive button.
 */
function DiscardPendingWritesDialog({
  action,
  count,
  onCancel,
  onDiscard,
}: {
  action: RecoveryAction;
  count: number;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  const plural = count === 1 ? 'change' : 'changes';
  const verb = action === 'reload' ? 'Reloading' : 'Leaving this page';

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="discard-pending-writes-title"
      aria-describedby="discard-pending-writes-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay px-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface p-5 text-left motion-safe:animate-modal-scale-in">
        <h2
          id="discard-pending-writes-title"
          className="mb-2 text-sm font-semibold text-neutral-text-primary"
        >
          {count} unsynced {plural} would be lost
        </h2>
        <p id="discard-pending-writes-body" className="mb-4 text-xs text-neutral-text-secondary">
          {count === 1 ? 'A change you made has' : `${count} changes you made have`} not reached the
          server yet, and {count === 1 ? 'it is' : 'they are'} only stored in this tab. {verb} now
          discards {count === 1 ? 'it' : 'them'} for good.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="primary" onClick={onCancel}>
            Stay on this page
          </Button>
          <Button variant="secondary" onClick={onDiscard}>
            {action === 'reload' ? 'Reload anyway' : 'Go to home anyway'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The route-level `errorElement` (issue 1654). Replaces React Router's built-in
 * default error screen — the raw "Unexpected Application Error!" + "💿 Hey
 * developer 👋" dump — which otherwise reaches end users on any lazy-chunk load
 * failure or render throw in a route subtree.
 *
 * Two responsibilities, deliberately split so neither leaks into the other:
 *  - the USER sees a calm, branded surface (v2 EmptyState anatomy, rule 177) with
 *    plain-language copy and a recovery path — never the internal error text;
 *  - the DEVELOPER still gets the real error + stack on the console (where React
 *    Router used to print its hint), so nothing is lost for debugging.
 *
 * `role="alert"` so assistive tech announces the failure assertively — this is an
 * error the user landed in, not a calm empty view. (An empty state carries no
 * region of its own since ADR-0989; it announces politely through the shell.) Recovery: **Reload** re-fetches the failed chunk (the actual remedy for a
 * stale/failed dynamic import); **Go to home** hard-navigates to `/` for the case
 * where the current route itself is the problem.
 *
 * Wired at the route tree root (whole-app net) and again on `ProjectShell` /
 * `ProgramShell` (so a single view failure keeps the sidebar and the user can
 * navigate away) — see `router.tsx`.
 *
 * Focus (web-rule 224): the erroring route subtree unmounts, dropping focus to
 * `document.body`, so we move focus to the heading on mount — otherwise a keyboard
 * or screen-reader user would have to blind-Tab from `body` to reach the recovery
 * actions that are the whole point of this surface.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Non-null while a recovery action is waiting on the discard confirmation.
  const [confirming, setConfirming] = useState<{ action: RecoveryAction; count: number } | null>(
    null,
  );

  // Preserve the developer signal without ever showing it to a user. Guard the
  // console call so SSR/headless render paths without a console don't throw.
  if (typeof console !== 'undefined') {
    console.error('[RouteErrorBoundary] a route failed to render:', error);
  }

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Report to the operator's collector (no-op unless configured) once per
  // distinct error — keyed on `error` so a re-render doesn't re-send.
  useEffect(() => {
    reportError(error, {
      boundary: 'route',
      route: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }, [error]);

  const chunkFailure = isChunkLoadError(error);

  // Both recovery actions leave the document, which discards TanStack Query's
  // in-memory paused/in-flight mutation queue. Ask the queue at click time — the
  // count is read here, not via a hook, because this surface can render outside
  // the QueryClientProvider (see getPendingWriteCount).
  function requestRecovery(action: RecoveryAction) {
    const count = getPendingWriteCount();
    if (count > 0) {
      setConfirming({ action, count });
      return;
    }
    performRecovery(action);
  }

  const title = chunkFailure ? "Couldn't finish loading" : 'Something went wrong';
  const description = chunkFailure
    ? "A part of the app didn't load — this usually happens right after an update. Reloading should put it right."
    : 'We hit an unexpected error. Reload this view, or head back to your home screen.';

  return (
    <div
      role="alert"
      className="flex h-full flex-1 flex-col items-center justify-center px-6 py-16 text-center motion-safe:animate-empty-state-in"
    >
      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary">
        <WarningIcon aria-hidden="true" className="h-8 w-8" />
      </div>
      {/* tabIndex + `focus:` (not `focus-visible:`, which browsers may withhold on
          a scripted .focus()) so the ring reliably shows when we move focus here. */}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 rounded text-[17px] font-semibold text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {title}
      </h2>
      <p className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-neutral-text-secondary">
        {description}
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={() => requestRecovery('reload')}>
          Reload
        </Button>
        <Button variant="secondary" onClick={() => requestRecovery('home')}>
          Go to home
        </Button>
      </div>
      {confirming && (
        <DiscardPendingWritesDialog
          action={confirming.action}
          count={confirming.count}
          onCancel={() => setConfirming(null)}
          onDiscard={() => performRecovery(confirming.action)}
        />
      )}
    </div>
  );
}
