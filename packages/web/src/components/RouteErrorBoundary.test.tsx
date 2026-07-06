import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { RouteErrorBoundary } from './RouteErrorBoundary';

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

beforeEach(() => {
  // React and React Router both log caught errors to console.error; silence the
  // noise but keep the spy so we can assert our own developer-signal log fires.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
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
