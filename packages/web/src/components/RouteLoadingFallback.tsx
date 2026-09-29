import { useEffect, useState } from 'react';
import { LoadingSkeleton } from './LoadingSkeleton';
import { QueryErrorState } from './QueryErrorState';

/**
 * How long the route placeholder may stand before it gives the user a way out.
 *
 * A route chunk normally resolves in well under a second, and a slow network
 * still lands in a few. Past this bound the load has stalled rather than being
 * slow, and the ghost has stopped telling the truth.
 */
export const ROUTE_LOAD_STALL_MS = 15_000;

/**
 * Fallback rendered inside Suspense while a lazy route chunk is loading.
 *
 * This is the first frame of *every* navigation, so it is the most-seen loading
 * state in the app — and it used to be the one place that broke rule 248 with a
 * bare centred "Loading…" (#2431). It ghosts the generic shell shape (toolbar
 * band + content rows) rather than a per-route shape: the chunk hasn't resolved,
 * so which surface is arriving is precisely what we don't yet know. Once it
 * resolves, the surface's own rule-248 skeleton takes over for its query.
 *
 * The ghost is bounded (rule 374). A chunk `import()` that REJECTS reaches
 * `RouteErrorBoundary`, but one that never settles — a module request the dev
 * server or a proxy holds open, a stalled connection — rejects nothing, so
 * Suspense would keep the ghost up forever with no error and no exit. After
 * {@link ROUTE_LOAD_STALL_MS} the ghost gives way to the
 * shared error state, whose Retry reloads the page and so re-requests the chunk.
 * If the chunk lands first, Suspense unmounts this component and the timer is
 * cleared with it; a chunk that is merely slow and lands after the bound still
 * replaces the error the same way, so the bound never strands a working load.
 */
export function RouteLoadingFallback() {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setStalled(true), ROUTE_LOAD_STALL_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (stalled) {
    return <QueryErrorState message="This view is taking too long to load." />;
  }
  return <LoadingSkeleton label="Loading…" variant="shell" rows={4} />;
}
