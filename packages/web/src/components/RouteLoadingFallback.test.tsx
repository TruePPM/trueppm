import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { ROUTE_LOAD_STALL_MS, RouteLoadingFallback } from './RouteLoadingFallback';

describe('RouteLoadingFallback (rule 374)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the shell ghost while the chunk is inside the bound', () => {
    render(<RouteLoadingFallback />);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(ROUTE_LOAD_STALL_MS - 1);
    });
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('replaces the ghost with an error and a Retry once the load has stalled', () => {
    render(<RouteLoadingFallback />);
    act(() => {
      vi.advanceTimersByTime(ROUTE_LOAD_STALL_MS);
    });
    expect(screen.queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This view is taking too long to load.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Retry reloads the page, which re-requests the stalled chunk', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    });
    render(<RouteLoadingFallback />);
    act(() => {
      vi.advanceTimersByTime(ROUTE_LOAD_STALL_MS);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('a never-settling lazy chunk under Suspense ends at the bounded exit, not the ghost', () => {
    // An import() that neither resolves nor rejects, so no error boundary
    // ever sees it.
    const Stalled = lazy(() => new Promise<{ default: () => null }>(() => {}));
    render(
      <Suspense fallback={<RouteLoadingFallback />}>
        <Stalled />
      </Suspense>,
    );
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(ROUTE_LOAD_STALL_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('taking too long to load');
  });

  it('clears its timer when the chunk lands first', () => {
    const clear = vi.spyOn(window, 'clearTimeout');
    const { unmount } = render(<RouteLoadingFallback />);
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
