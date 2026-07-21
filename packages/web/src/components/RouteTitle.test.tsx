import { act, render } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, type UIMatch } from 'react-router';
import { describe, it, expect, beforeEach } from 'vitest';
import { RouteTitle, resolveRouteTitle } from './RouteTitle';
import type { RouteHandle } from '@/router/routeHandle';

/**
 * Builds a minimal but structurally valid UIMatch for `resolveRouteTitle`
 * unit tests — only `handle` is exercised by the function under test, but
 * the type requires the rest of the shape.
 */
function mockMatch(handle?: RouteHandle): UIMatch {
  return {
    id: 'test',
    pathname: '/test',
    params: {},
    data: undefined,
    loaderData: undefined,
    handle,
  };
}

describe('resolveRouteTitle', () => {
  it('returns the deepest matched route handle.title', () => {
    const matches = [
      mockMatch({ title: 'Ancestor' }),
      mockMatch(undefined),
      mockMatch({ title: 'Leaf' }),
    ];
    expect(resolveRouteTitle(matches)).toBe('Leaf');
  });

  it('walks up to the nearest ancestor with a title when the leaf has none', () => {
    // Mirrors index-redirect / shell routes (e.g. ProjectShell, ProgramShell)
    // that render no title of their own — the child's title should win when
    // present, and the parent's should be used when the matched leaf is a
    // titleless redirect route.
    const matches = [mockMatch({ title: 'Team' }), mockMatch(undefined)];
    expect(resolveRouteTitle(matches)).toBe('Team');
  });

  it('returns an empty string when no matched route declares a title', () => {
    const matches = [mockMatch(undefined), mockMatch(undefined)];
    expect(resolveRouteTitle(matches)).toBe('');
  });

  it('returns an empty string for an empty match list', () => {
    expect(resolveRouteTitle([])).toBe('');
  });
});

/**
 * Mirrors the real `RootLayout` in router.tsx: mounts `RouteTitle` once above
 * an `<Outlet />` so every descendant route's `handle.title` drives
 * `document.title` without each page opting in individually.
 */
function TestRootLayout() {
  return (
    <>
      <RouteTitle />
      {/* Mirrors AppShell: the focus target RouteAnnouncer moves focus to on
          SPA navigation (#2200). tabIndex={-1} so it accepts programmatic focus. */}
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

function buildTestRouter(initialEntry: string) {
  return createMemoryRouter(
    [
      {
        element: <TestRootLayout />,
        children: [
          {
            path: '/schedule',
            element: <div>Schedule page</div>,
            handle: { title: 'Schedule' } satisfies RouteHandle,
          },
          {
            path: '/board',
            element: <div>Board page</div>,
            handle: { title: 'Board' } satisfies RouteHandle,
          },
          {
            // A second, distinct path that resolves to the SAME title — used to
            // verify same-title navigations still re-announce (#2200).
            path: '/board-2',
            element: <div>Board page 2</div>,
            handle: { title: 'Board' } satisfies RouteHandle,
          },
          // No `handle` — a route that hasn't opted in, or a redirect shim.
          { path: '/no-title', element: <div>No title page</div> },
          {
            // Shell route with no title of its own; children provide theirs
            // (mirrors ProjectShell/ProgramShell in router.tsx).
            path: '/team',
            element: <Outlet />,
            children: [
              { index: true, element: <div>Team index</div> },
              {
                path: 'roster',
                element: <div>Roster page</div>,
                handle: { title: 'Roster' } satisfies RouteHandle,
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
}

describe('RouteTitle (router-level document title, issue 1915)', () => {
  beforeEach(() => {
    document.title = '';
  });

  it('sets document.title on initial mount for a representative route', () => {
    render(<RouterProvider router={buildTestRouter('/schedule')} />);
    expect(document.title).toBe('Schedule — TruePPM');
  });

  it('sets a different title for another representative route', () => {
    render(<RouterProvider router={buildTestRouter('/board')} />);
    expect(document.title).toBe('Board — TruePPM');
  });

  it('updates document.title on navigation between routes', async () => {
    const router = buildTestRouter('/schedule');
    render(<RouterProvider router={router} />);
    expect(document.title).toBe('Schedule — TruePPM');

    await act(async () => {
      await router.navigate('/board');
    });
    expect(document.title).toBe('Board — TruePPM');
  });

  it('falls back to the bare app name when the matched route declares no title', () => {
    render(<RouterProvider router={buildTestRouter('/no-title')} />);
    expect(document.title).toBe('TruePPM');
  });

  it("uses the titleless shell's child title when navigating into a nested route", () => {
    const router = buildTestRouter('/team/roster');
    render(<RouterProvider router={router} />);
    expect(document.title).toBe('Roster — TruePPM');
  });

  it("falls back to the app name when a titleless shell's index child has no title either", () => {
    render(<RouterProvider router={buildTestRouter('/team')} />);
    expect(document.title).toBe('TruePPM');
  });
});

describe('RouteAnnouncer (SPA route announcement + focus, #2200)', () => {
  it('mounts a persistent polite live region that is empty on initial load', () => {
    const { getByTestId } = render(<RouterProvider router={buildTestRouter('/schedule')} />);
    const region = getByTestId('route-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('role', 'status');
    // No announcement on first paint — that would double-announce / steal focus.
    expect(region).toHaveTextContent('');
  });

  it('announces the resolved page name on navigation', async () => {
    const router = buildTestRouter('/schedule');
    const { getByTestId } = render(<RouterProvider router={router} />);
    expect(getByTestId('route-announcer')).toHaveTextContent('');

    await act(async () => {
      await router.navigate('/board');
    });
    expect(getByTestId('route-announcer')).toHaveTextContent('Board');
  });

  it('moves focus into #main-content on navigation (WCAG 2.4.3)', async () => {
    const router = buildTestRouter('/schedule');
    render(<RouterProvider router={router} />);

    await act(async () => {
      await router.navigate('/board');
    });
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });

  it('re-announces when two different routes resolve to the same title (#2200)', async () => {
    const router = buildTestRouter('/schedule');
    const { getByTestId } = render(<RouterProvider router={router} />);

    await act(async () => {
      await router.navigate('/board');
    });
    const first = getByTestId('route-announcer').textContent;
    expect(first).toMatch(/Board/);

    await act(async () => {
      await router.navigate('/board-2');
    });
    const second = getByTestId('route-announcer').textContent;
    // Same resolved title, but the toggled trailing space forces a changed
    // text node so a screen reader speaks it again.
    expect(second).toMatch(/Board/);
    expect(second).not.toBe(first);
  });

  it('falls back to a generic message when the target route declares no title', async () => {
    const router = buildTestRouter('/schedule');
    const { getByTestId } = render(<RouterProvider router={router} />);

    await act(async () => {
      await router.navigate('/no-title');
    });
    expect(getByTestId('route-announcer')).toHaveTextContent('Page changed');
  });
});
