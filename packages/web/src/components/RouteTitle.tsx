import { useMatches, type UIMatch } from 'react-router';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { RouteHandle } from '@/router/routeHandle';

/**
 * Resolves the document title from the deepest matched route's
 * `handle.title` (declared in `router.tsx`), walking up the match stack
 * until one is found. Routes with no handle of their own — redirect shims,
 * index-redirect routes, layout/shell routes — fall through to the nearest
 * ancestor that declared a title.
 */
export function resolveRouteTitle(matches: UIMatch[]): string {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const handle = matches[i].handle as RouteHandle | undefined;
    if (handle?.title) return handle.title;
  }
  return '';
}

/**
 * Router-level document title (issue 1915, completes #1327 A4).
 *
 * #1327's A4 fix added a per-route `<title>` only to the 3 views that also
 * needed h1 landmarks (Schedule, Board, Resources) via manual
 * `usePageTitle()` calls. Every other route was left with a stale/generic
 * title. Mounting `RouteTitle` once at the root of the route tree makes
 * every route get a descriptive title by declaring `handle: { title }` on
 * its route definition, instead of relying on each page component to opt
 * in individually — a router-level source of truth screen-reader and
 * browser-tab users benefit from on every visit, not just three.
 *
 * Renders nothing; only exists to run the `useMatches()` + `usePageTitle()`
 * effect once per navigation.
 */
export function RouteTitle() {
  const matches = useMatches();
  usePageTitle(resolveRouteTitle(matches));
  return null;
}
