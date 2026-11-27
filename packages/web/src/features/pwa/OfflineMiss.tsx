import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/Button';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

/**
 * True when this page load started with no network. Read once at module
 * evaluation (app start): a cold offline launch has no in-memory data anywhere,
 * which is the only case the fallback replaces a page (ADR-1523 §5).
 */
const BOOTED_OFFLINE = typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Routes that work from a copy on this device: My Work (ADR-1523 §4) and the board
 * (ADR-0220's snapshot). Everything else needs a connection on a cold launch.
 */
export function isOfflineCapableRoute(pathname: string): boolean {
  return pathname.startsWith('/me/work') || /^\/projects\/[^/]+\/board(\/|$)/.test(pathname);
}

/**
 * "This view isn't cached" (ADR-1523 §5, #1427). Honest about what needs a
 * connection, and points at what still works offline.
 */
export function OfflineMiss() {
  return (
    <section
      aria-labelledby="offline-miss-title"
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <h1 id="offline-miss-title" className="text-lg font-semibold text-neutral-text-primary">
        This view isn&rsquo;t cached
      </h1>
      <p className="text-sm text-neutral-text-secondary">
        This page needs a connection. Your tasks and time tracking still work offline.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Link
          to="/me/work"
          className="inline-flex min-h-[44px] items-center rounded-control bg-sage-500 px-4 text-sm font-semibold text-navy-900 hover:bg-sage-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2"
        >
          Back to My Work
        </Link>
        <Button
          variant="secondary"
          size="lg"
          className="min-h-[44px]"
          onClick={() => window.location.reload()}
        >
          Retry connection
        </Button>
      </div>
    </section>
  );
}

/**
 * Renders the route, or {@link OfflineMiss} on a cold offline launch of a route
 * with no offline copy. A warm session that loses its connection keeps whatever
 * each page already has on screen. `bootedOffline` is injectable for tests.
 */
export function OfflineRouteGate({
  children,
  bootedOffline = BOOTED_OFFLINE,
}: {
  children: ReactNode;
  bootedOffline?: boolean;
}) {
  const online = useOnlineStatus();
  const { pathname } = useLocation();
  if (bootedOffline && !online && !isOfflineCapableRoute(pathname)) return <OfflineMiss />;
  return <>{children}</>;
}
