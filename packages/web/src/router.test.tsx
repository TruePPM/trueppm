import { isValidElement, useEffect, useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { routes } from './router';
import { AppShell } from '@/features/shell/AppShell';
import { PendingWritesGuard } from '@/features/shell/PendingWritesGuard';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { useAuthStore } from '@/stores/authStore';

/**
 * Router-level crash isolation (#2834).
 *
 * Every other test in this area is a unit test — `RouteErrorBoundary.test.tsx`,
 * `PendingWritesGuard.test.tsx` and `ProjectShell.test.tsx` each mount their own
 * component in isolation. Nothing asserted the *composed* fact that actually
 * protects user data: that a throw inside a route leaves `AppShell` — and with it
 * the `PendingWritesGuard` that owns the `beforeunload` warning — mounted. That
 * gap is why seven shell-hosted routes shipped with no `errorElement` at all, and
 * why the two routes issue 1654 "fixed" were never verified either.
 *
 * The route tree is the real one, imported from `router.tsx`. Only two elements
 * are substituted, and never mutated in place: `AppShell` becomes a probe that
 * renders identifiable chrome plus the real `PendingWritesGuard`, and the route
 * under test becomes a component that throws. AppShell's own contents are tested
 * elsewhere; what is under test here is *where the boundary sits relative to it*.
 */

/** Routes that must survive a child throw with the shell intact. */
const SHELL_HOSTED_ROUTES: ReadonlyArray<{ path: string; url: string }> = [
  // The seven that shipped unprotected (#2834).
  { path: 'me/work', url: '/me/work' },
  { path: 'me/assets', url: '/me/assets' },
  { path: 'me/timesheet', url: '/me/timesheet' },
  { path: 'me/notifications', url: '/me/notifications' },
  { path: 'me/settings/general', url: '/me/settings/general' },
  { path: 'resources', url: '/resources' },
  { path: 'programs', url: '/programs' },
  // The rest of the `me/settings/*` family, covered by the same gap.
  { path: 'me/settings/notifications', url: '/me/settings/notifications' },
  { path: 'me/settings/connected-accounts', url: '/me/settings/connected-accounts' },
  { path: 'me/settings/api-tokens', url: '/me/settings/api-tokens' },
  // The two issue-1654 routes — protected since 1654, never actually verified.
  { path: 'projects/:projectId', url: '/projects/p-1' },
  { path: 'programs/:programId', url: '/programs/g-1' },
];

function Boom(): never {
  throw new Error('route body exploded');
}

/**
 * Stands in for `AppShell`: identifiable chrome, the real pending-writes guard,
 * and an `<Outlet>` for the route body. If the boundary is missing or sits above
 * the shell, none of this survives the throw — which is the whole assertion.
 */
function ShellProbe() {
  return (
    <div>
      <nav aria-label="Sidebar" data-testid="shell-sidebar">
        sidebar
      </nav>
      <PendingWritesGuard />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

/** Starts a mutation that never settles, so the guard has something to protect. */
function PendingWriteSeeder() {
  const { mutate } = useMutation<void, Error, void>({
    mutationFn: () => new Promise<void>(() => {}),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);
  return null;
}

function isElementOf(node: unknown, component: unknown): boolean {
  return isValidElement(node) && node.type === component;
}

/** The `path: '/'` route whose element is AppShell — the shell level (#2834). */
function findShellRoute(tree: readonly RouteObject[]): RouteObject {
  for (const route of tree) {
    if (isElementOf(route.element, AppShell)) return route;
    const found = route.children && findShellRoute(route.children);
    if (found) return found;
  }
  throw new Error('AppShell route not found in the route tree');
}

interface CrashOptions {
  /** Drop the target route's errorElement — the pre-#2834 shape, for a control. */
  stripErrorElement?: boolean;
}

/**
 * Returns a copy of the real route tree with AppShell swapped for {@link ShellProbe}
 * and `targetPath`'s element swapped for a thrower. Purely functional — the
 * imported `routes` array is module-level and shared, so it is never mutated.
 */
function withCrashingRoute(
  tree: readonly RouteObject[],
  targetPath: string,
  options: CrashOptions = {},
): RouteObject[] {
  return tree.map((route) => {
    if (isElementOf(route.element, AppShell)) {
      return {
        ...route,
        element: <ShellProbe />,
        children: (route.children ?? []).map((child) => {
          if (child.path !== targetPath) return child;
          const crashed: RouteObject = { ...child, element: <Boom />, children: undefined };
          if (options.stripErrorElement) delete crashed.errorElement;
          return crashed;
        }),
      } as RouteObject;
    }
    if (!route.children) return route;
    return { ...route, children: withCrashingRoute(route.children, targetPath, options) };
  });
}

/** Dispatch a cancelable beforeunload and report whether the guard blocked it. */
function unloadBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function renderCrash(target: { path: string; url: string }, options: CrashOptions = {}) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const router = createMemoryRouter(withCrashingRoute(routes, target.path, options), {
    initialEntries: [target.url],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PendingWriteSeeder />
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

let errorSpy: MockInstance;

beforeEach(() => {
  // React and React Router both log a caught render error; silence the noise.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // RequireAuth gates the whole shell subtree; seed a hydrated, authenticated
  // session so it renders its Outlet without attempting a token bootstrap.
  useAuthStore.setState({
    _hasHydrated: true,
    isAuthenticated: true,
    sessionExpired: false,
    accessToken: 'router-test-token',
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('router — every shell-hosted route carries an errorElement (#2834)', () => {
  /**
   * The regression guard. Enumerating the shell's children (rather than asserting
   * on the seven paths that happened to be broken) is what makes a *newly added*
   * route unable to silently omit the boundary — which is the failure mode that
   * produced this issue in the first place.
   */
  it('every direct child of the AppShell route declares an errorElement', () => {
    const shell = findShellRoute(routes);
    const children = shell.children ?? [];

    // Guard the guard: if a refactor empties or re-nests the children, the loop
    // below would pass vacuously.
    expect(children.length).toBeGreaterThan(20);

    const unprotected = children
      .filter((child) => !child.errorElement)
      .map((child) => child.path ?? (child.index ? '(index)' : '(unnamed)'));
    expect(unprotected).toEqual([]);
  });

  it('binds RouteErrorBoundary specifically — not some other element', () => {
    const shell = findShellRoute(routes);
    for (const child of shell.children ?? []) {
      expect(isElementOf(child.errorElement, RouteErrorBoundary)).toBe(true);
    }
  });

  it('still hosts every route that #2834 found unprotected', () => {
    const shell = findShellRoute(routes);
    const paths = new Set((shell.children ?? []).map((child) => child.path));
    for (const { path } of SHELL_HOSTED_ROUTES) {
      expect(paths.has(path)).toBe(true);
    }
  });
});

describe('router — a route throw does not unmount the shell (#2834)', () => {
  it.each(SHELL_HOSTED_ROUTES)('$path keeps the shell and the write guard', async (target) => {
    renderCrash(target);

    // The route body is replaced by the branded boundary…
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // …while the shell around it stays painted, so the user can navigate away.
    expect(screen.getByTestId('shell-sidebar')).toBeInTheDocument();
    // And the guard that protects the in-memory write queue is still registered.
    await waitFor(() => expect(unloadBlocked()).toBe(true));
  });

  it('control: without the errorElement the shell and the write guard are lost', async () => {
    // The pre-#2834 shape. Proves the assertions above have teeth: the throw
    // bubbles past AppShell to the RequireAuth-level net, the shell unmounts,
    // and the beforeunload protection goes with it.
    renderCrash({ path: 'me/timesheet', url: '/me/timesheet' }, { stripErrorElement: true });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-sidebar')).toBeNull();
    await waitFor(() => expect(unloadBlocked()).toBe(false));
  });
});
