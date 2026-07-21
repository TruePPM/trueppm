import { useEffect, useRef, useState } from 'react';
import { useLocation, useMatches, type UIMatch } from 'react-router';
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
 * Router-level document title (issue 1915, completes #1327 A4) plus the
 * screen-reader route announcer (#2200).
 *
 * #1327's A4 fix added a per-route `<title>` only to the 3 views that also
 * needed h1 landmarks (Schedule, Board, Resources) via manual
 * `usePageTitle()` calls. Every other route was left with a stale/generic
 * title. Mounting `RouteTitle` once at the root of the route tree makes
 * every route get a descriptive title by declaring `handle: { title }` on
 * its route definition, instead of relying on each page component to opt
 * in individually — a router-level source of truth screen-reader and
 * browser-tab users benefit from on every visit, not just three.
 */
export function RouteTitle() {
  const matches = useMatches();
  const title = resolveRouteTitle(matches);
  usePageTitle(title);
  return <RouteAnnouncer title={title} />;
}

/**
 * Screen-reader route announcer + focus manager (WCAG 4.1.3 Status Messages /
 * 2.4.3 Focus Order, #2200).
 *
 * A client-side navigation only mutates `document.title`, which is not
 * reliably spoken on SPA route swaps, and nothing moves focus — so SR users
 * get no signal the view changed and keyboard users stay stranded on the
 * previous page's controls. On every pathname change (after the initial
 * load) this announces the resolved page name through a *persistent* polite
 * live region and moves focus into `#main-content`.
 *
 * The live region is mounted once and permanently so the message is injected
 * into an already-present node — a region mounted at the same instant as its
 * text is not announced by NVDA/VoiceOver (the toast/offline-banner defect,
 * #2203).
 */
function RouteAnnouncer({ title }: { title: string }) {
  const { pathname } = useLocation();
  const [message, setMessage] = useState('');
  const lastPathRef = useRef<string | null>(null);
  // Toggled each announcement to append an inaudible trailing space, so two
  // consecutive routes that resolve to the *same* title (e.g. project A
  // Overview → project B Overview) still produce a changed text node and are
  // re-announced — React skips the DOM mutation for an identical string.
  const toggleRef = useRef(false);

  useEffect(() => {
    // Skip the initial mount: announcing/focusing on first paint would
    // double-announce the landing view and steal focus from the app.
    if (lastPathRef.current === null) {
      lastPathRef.current = pathname;
      return;
    }
    // Only react to a genuine path change — a title-only update (deps include
    // `title`) on the same path must not re-announce or re-move focus.
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    toggleRef.current = !toggleRef.current;
    setMessage((title || 'Page changed') + (toggleRef.current ? ' ' : ''));
    // `#main-content` lives in AppShell (authed routes only) and carries
    // `tabIndex={-1}` so it accepts programmatic focus without becoming a
    // tab stop. Absent on public routes (login) — the optional chain no-ops.
    document.getElementById('main-content')?.focus();
  }, [pathname, title]);

  return (
    <div
      aria-live="polite"
      role="status"
      className="sr-only"
      data-testid="route-announcer"
    >
      {message}
    </div>
  );
}
