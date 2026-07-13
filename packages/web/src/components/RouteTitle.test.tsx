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
      <Outlet />
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
