import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { usePausableAutoDismiss } from './usePausableAutoDismiss';

/**
 * Unit coverage for the shared auto-dismiss timer (#3356).
 *
 * `ToastHost.test.tsx` covers the same invariant through the global host and
 * `ScheduleView.test.tsx` through the Schedule's own renderer; this file pins the
 * mechanism itself, including the two behaviors neither caller can reach from the
 * outside — the stale-pause reset that a host outliving its surface needs, and the
 * ref indirection that keeps an unstable `onDismiss` from making a toast permanent.
 */

interface HarnessProps {
  active?: boolean;
  durationMs?: number;
  restartKey?: unknown;
  onDismiss: () => void;
  onFocusWithinChange?: (within: boolean) => void;
}

function Harness({
  active = true,
  durationMs = 1000,
  restartKey = 'a',
  onDismiss,
  onFocusWithinChange,
}: HarnessProps) {
  const { paused, pauseHandlers } = usePausableAutoDismiss({
    active,
    durationMs,
    restartKey,
    // A fresh arrow on every render, deliberately — the caller in `ToastHost` and
    // the one in `ScheduleView` both pass one, and a timer effect that depended on
    // its identity would re-arm forever and never fire.
    onDismiss: () => onDismiss(),
    onFocusWithinChange,
  });
  if (!active) return null;
  return (
    <div data-testid="surface" {...pauseHandlers}>
      <span>{paused ? 'paused' : 'running'}</span>
      <button type="button">Undo</button>
      <button type="button">Details</button>
    </div>
  );
}

describe('usePausableAutoDismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dismisses once the dwell elapses untouched', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('survives an onDismiss whose identity changes every render', () => {
    // The negative control for the `dismissRef` indirection: with `onDismiss` in the
    // effect's dependency list the timer is torn down and re-armed on every render,
    // so the dwell never completes and the surface is permanent. What makes the
    // control real is that the clock is advanced ONLY in slices smaller than the
    // dwell, with a re-render between each and never a full dwell after the last
    // one — a trailing `advanceTimersByTime(1000)` would let the buggy version pass.
    const onDismiss = vi.fn();
    const { rerender } = render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    for (let i = 0; i < 30; i += 1) {
      act(() => {
        vi.advanceTimersByTime(50);
      });
      rerender(<Harness onDismiss={onDismiss} durationMs={1000} />);
    }
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pauses while hovered and restarts the FULL dwell on leave (WCAG 2.2.1)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    const surface = screen.getByTestId('surface');
    act(() => {
      vi.advanceTimersByTime(900);
      fireEvent.mouseEnter(surface);
    });
    expect(screen.getByText('paused')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      fireEvent.mouseLeave(surface);
    });
    // A fresh, honest window — not the 100ms remainder that was left when the
    // pointer arrived.
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never auto-removes a surface that contains focus (web rule 356(d))', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    act(() => {
      fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('does not resume when focus moves between children of the same surface', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    const details = screen.getByRole('button', { name: 'Details' });
    act(() => {
      fireEvent.focus(undo);
    });
    // focusout on Undo with Details as relatedTarget — focus never left the surface.
    act(() => {
      fireEvent.blur(undo, { relatedTarget: details });
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps the pause when one of hover and focus is released but the other holds', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    const surface = screen.getByTestId('surface');
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => {
      fireEvent.mouseEnter(surface);
      fireEvent.focus(undo);
    });
    act(() => {
      fireEvent.mouseLeave(surface);
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      fireEvent.blur(undo);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('reports focus-within to the caller in both directions', () => {
    const onFocusWithinChange = vi.fn();
    render(<Harness onDismiss={vi.fn()} onFocusWithinChange={onFocusWithinChange} />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => {
      fireEvent.focus(undo);
    });
    expect(onFocusWithinChange).toHaveBeenLastCalledWith(true);
    act(() => {
      fireEvent.blur(undo);
    });
    expect(onFocusWithinChange).toHaveBeenLastCalledWith(false);
  });

  it('clears a stale pause when the surface goes away, so the NEXT one still dismisses', () => {
    // The failure this guards is invisible in `ToastHost`, where each pill is keyed by
    // id and remounts with fresh state. The Schedule renders ONE renderer for every
    // toast, so a pill dismissed out from under the pointer (clicking Undo unmounts it;
    // no `mouseleave` fires for an element that no longer exists) would leave `hovered`
    // true forever and the next toast would never auto-dismiss.
    const onDismiss = vi.fn();
    const { rerender } = render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId('surface'));
      fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));
    });
    // The surface is removed while both flags are held.
    rerender(<Harness onDismiss={onDismiss} durationMs={1000} active={false} />);
    // A new one arrives, untouched.
    rerender(<Harness onDismiss={onDismiss} durationMs={1000} active restartKey="b" />);
    expect(screen.getByText('running')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('restarts the clock on a restartKey change without touching the pause', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Harness onDismiss={onDismiss} durationMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(900);
    });
    rerender(<Harness onDismiss={onDismiss} durationMs={1000} restartKey="b" />);
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('arms no timer at all while inactive', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} durationMs={1000} active={false} />);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
