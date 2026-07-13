/**
 * Shape of the `handle` object attached to route definitions in `router.tsx`.
 *
 * `RouteTitle` (`@/components/RouteTitle`) reads `handle.title` off the
 * deepest matched route via `useMatches()` to drive `document.title` — this
 * is the router-level source of truth for page titles (issue 1915, completes
 * #1327 A4). Routes with no `handle` (redirect shims, index-redirect routes)
 * simply fall through to whichever ancestor route declared a title.
 */
export interface RouteHandle {
  /** Human-readable page title, e.g. "Schedule". Combined with the app name
   *  by `usePageTitle` (e.g. "Schedule — TruePPM"). */
  title?: string;
}
