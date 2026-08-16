import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { RouteErrorBoundary } from './RouteErrorBoundary';

// The boundary asks the write queue directly (it can render outside the
// QueryClientProvider), so the count is what a test needs to drive. `vi.hoisted`
// keeps the handle out of the TDZ the mock factory would otherwise hit.
const pending = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/hooks/useSyncStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useSyncStatus')>();
  return { ...actual, getPendingWriteCount: () => pending.count };
});

/**
 * Renders a route whose element throws `message`, with RouteErrorBoundary wired
 * as its `errorElement` — mirroring the real router wiring (issue 1654).
 */
function renderThrowing(message: string) {
  function Boom(): never {
    throw new Error(message);
  }
  const router = createMemoryRouter([
    { path: '/', element: <Boom />, errorElement: <RouteErrorBoundary /> },
  ]);
  return render(<RouterProvider router={router} />);
}

let errorSpy: MockInstance;
let reload: ReturnType<typeof vi.fn<() => void>>;
let fakeLocation: { reload: () => void; href: string; pathname: string };
const realLocation = window.location;

beforeEach(() => {
  // React and React Router both log caught errors to console.error; silence the
  // noise but keep the spy so we can assert our own developer-signal log fires.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  pending.count = 0;
  // jsdom neither implements `location.reload()` nor tolerates an `href`
  // assignment (it logs "Not implemented: navigation"), so swap the whole object
  // out for a recorder and restore it after each test.
  reload = vi.fn();
  fakeLocation = { reload, href: '', pathname: '/me/timesheet' };
  Object.defineProperty(window, 'location', { configurable: true, value: fakeLocation });
});

afterEach(() => {
  errorSpy.mockRestore();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('RouteErrorBoundary', () => {
  it('replaces the raw error screen with a branded alert on a generic throw', () => {
    renderThrowing('some internal explosion');

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByText(/Reload this view, or head back to your home screen/i),
    ).toBeInTheDocument();

    // Never leak the internal error text or React Router's dev-facing default copy.
    expect(screen.queryByText(/some internal explosion/)).toBeNull();
    expect(screen.queryByText(/Hey developer/i)).toBeNull();
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
  });

  it('offers Reload and Go-to-home recovery actions', () => {
    renderThrowing('boom');
    expect(screen.getByRole('button', { name: /^Reload$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to home/i })).toBeInTheDocument();
  });

  it('moves focus to the heading on mount so recovery actions are reachable (web-rule 224)', () => {
    // The erroring subtree unmounts and drops focus to <body>; the boundary must
    // pull focus to itself, or a keyboard/AT user cannot reach Reload / Go to home.
    renderThrowing('boom');
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toHaveFocus();
  });

  it('uses chunk-load-specific copy when a dynamic import fails', () => {
    renderThrowing(
      'Failed to fetch dynamically imported module: http://localhost:5173/src/features/today/TodayView.tsx',
    );
    expect(screen.getByText("Couldn't finish loading")).toBeInTheDocument();
    expect(screen.getByText(/A part of the app didn't load/i)).toBeInTheDocument();
    expect(screen.getByText(/Reloading should put it right/i)).toBeInTheDocument();
  });

  it('also recognizes the "Loading chunk N failed" phrasing', () => {
    renderThrowing('Loading chunk 42 failed.');
    expect(screen.getByText("Couldn't finish loading")).toBeInTheDocument();
  });

  it('preserves the developer signal by logging the real error to the console', () => {
    renderThrowing('diagnostic detail for a developer');
    const loggedOurTag = errorSpy.mock.calls.some(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('[RouteErrorBoundary]'),
    );
    expect(loggedOurTag).toBe(true);
  });
});

/**
 * The recovery actions leave the document, which discards TanStack Query's
 * in-memory write queue (#2834). `PendingWritesGuard`'s `beforeunload` prompt is
 * the normal protection, but it is mounted inside `AppShell` — exactly what a
 * crash can tear down — so the boundary asks the queue itself rather than
 * trusting a guard that may already be gone.
 */
describe('RouteErrorBoundary — discarding queued writes (#2834)', () => {
  it('reloads immediately when nothing is queued', async () => {
    pending.count = 0;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('navigates home immediately when nothing is queued', async () => {
    pending.count = 0;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /Go to home/i }));

    expect(fakeLocation.href).toBe('/');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('interrupts Reload with a confirmation naming the queued writes', async () => {
    pending.count = 3;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('3 unsynced changes would be lost')).toBeInTheDocument();
    expect(screen.getByText(/only stored in this tab/i)).toBeInTheDocument();
    // Nothing has been discarded yet.
    expect(reload).not.toHaveBeenCalled();
  });

  it('uses singular copy for a single queued write', async () => {
    pending.count = 1;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));

    expect(screen.getByText('1 unsynced change would be lost')).toBeInTheDocument();
  });

  it('seats focus on the safe action, never the discard button (rule 206)', async () => {
    pending.count = 2;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));

    expect(screen.getByRole('button', { name: 'Stay on this page' })).toHaveFocus();
  });

  it('“Stay on this page” dismisses the prompt and reloads nothing', async () => {
    pending.count = 2;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Stay on this page' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    // The error surface itself is still there — staying must not strand the user.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Escape dismisses the prompt without discarding', async () => {
    pending.count = 2;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('“Reload anyway” proceeds once the user has been told', async () => {
    pending.count = 2;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /^Reload$/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('interrupts Go-to-home too, with its own wording and confirmation', async () => {
    pending.count = 2;
    renderThrowing('boom');

    await userEvent.click(screen.getByRole('button', { name: /Go to home/i }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Leaving this page now discards them/i)).toBeInTheDocument();
    expect(fakeLocation.href).toBe('');

    await userEvent.click(screen.getByRole('button', { name: 'Go to home anyway' }));
    expect(fakeLocation.href).toBe('/');
  });
});
