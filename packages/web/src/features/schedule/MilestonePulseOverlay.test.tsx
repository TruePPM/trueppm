import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MilestonePulseOverlay } from './MilestonePulseOverlay';

beforeEach(() => {
  vi.useFakeTimers();
  // Default: motion-safe env so the overlay mounts.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({ matches: false, media: '', addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MilestonePulseOverlay', () => {
  it('renders no rings when triggerId is null', () => {
    render(<MilestonePulseOverlay x={100} y={100} triggerId={null} />);
    expect(screen.queryByTestId('milestone-pulse-overlay')).toBeNull();
  });

  it('mounts the SVG when triggerId becomes a value', () => {
    const { rerender } = render(<MilestonePulseOverlay x={100} y={100} triggerId={null} />);
    rerender(<MilestonePulseOverlay x={100} y={100} triggerId="task-1" />);
    expect(screen.getByTestId('milestone-pulse-overlay')).toBeInTheDocument();
  });

  it('positions the SVG centered at (x, y)', () => {
    render(<MilestonePulseOverlay x={100} y={50} triggerId="task-1" />);
    const svg = screen.getByTestId('milestone-pulse-overlay');
    expect(svg.style.left).toBe('76px'); // 100 - 24
    expect(svg.style.top).toBe('26px'); // 50 - 24
  });

  it('self-clears after 1.5 seconds', () => {
    render(<MilestonePulseOverlay x={100} y={100} triggerId="task-1" />);
    expect(screen.getByTestId('milestone-pulse-overlay')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByTestId('milestone-pulse-overlay')).toBeNull();
  });

  it('re-pulses when triggerId changes to a new value', () => {
    const { rerender } = render(<MilestonePulseOverlay x={100} y={100} triggerId="task-1" />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByTestId('milestone-pulse-overlay')).toBeNull();
    rerender(<MilestonePulseOverlay x={100} y={100} triggerId="task-2" />);
    expect(screen.getByTestId('milestone-pulse-overlay')).toBeInTheDocument();
  });

  it('does NOT mount under prefers-reduced-motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi
        .fn()
        .mockReturnValue({ matches: true, media: '', addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    render(<MilestonePulseOverlay x={100} y={100} triggerId="task-1" />);
    expect(screen.queryByTestId('milestone-pulse-overlay')).toBeNull();
  });

  it('renders two SVG circles for the staggered ring effect', () => {
    render(<MilestonePulseOverlay x={100} y={100} triggerId="task-1" />);
    const circles = screen.getByTestId('milestone-pulse-overlay').querySelectorAll('circle');
    expect(circles.length).toBe(2);
  });

  // --- the latch (#2380) --------------------------------------------------
  //
  // The animating node lives 1.5 s, which makes it unusable as a test signal:
  // an assertion has to catch a window that has already closed on a loaded
  // runner, and no timeout can fix a window-of-existence problem. The latch is
  // what lets a spec assert the outcome instead of racing it.

  const latch = () => screen.getByTestId('milestone-pulse-latch');

  it('exposes an empty latch before anything has pulsed', () => {
    render(<MilestonePulseOverlay x={100} y={100} triggerId={null} />);
    // Present-but-empty, not absent: a spec must be able to tell "mounted and
    // nothing pulsed" from "the component never rendered at all".
    expect(latch()).toHaveAttribute('data-pulsed-task-id', '');
  });

  it('records the pulsed task id on the latch', () => {
    const { rerender } = render(<MilestonePulseOverlay x={100} y={100} triggerId={null} />);
    rerender(<MilestonePulseOverlay x={100} y={100} triggerId="task-m1" />);
    expect(latch()).toHaveAttribute('data-pulsed-task-id', 'task-m1');
  });

  it('KEEPS the latch after the animation self-clears', () => {
    // The property the whole change exists for. Without it the only evidence a
    // pulse happened evaporates at 1.5 s.
    render(<MilestonePulseOverlay x={100} y={100} triggerId="task-m1" />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByTestId('milestone-pulse-overlay')).toBeNull();
    expect(latch()).toHaveAttribute('data-pulsed-task-id', 'task-m1');
  });

  it('advances the latch to the newest id when re-pulsed', () => {
    const { rerender } = render(<MilestonePulseOverlay x={100} y={100} triggerId="task-m1" />);
    rerender(<MilestonePulseOverlay x={100} y={100} triggerId="task-m2" />);
    expect(latch()).toHaveAttribute('data-pulsed-task-id', 'task-m2');
  });

  it('latches under prefers-reduced-motion even though nothing animates', () => {
    // Deliberate: reduced motion suppresses the animation, not the targeting.
    // A spec asking "did the deep link find the right milestone" must not
    // depend on whether the user animates.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi
        .fn()
        .mockReturnValue({ matches: true, media: '', addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    render(<MilestonePulseOverlay x={100} y={100} triggerId="task-m1" />);
    expect(screen.queryByTestId('milestone-pulse-overlay')).toBeNull();
    expect(latch()).toHaveAttribute('data-pulsed-task-id', 'task-m1');
  });

  it('keeps the latch out of layout and the a11y tree', () => {
    render(<MilestonePulseOverlay x={100} y={100} triggerId="task-m1" />);
    // `hidden` rather than a visually-hidden class: this carries no information
    // for a user and must not reach assistive tech or occupy space.
    expect(latch()).not.toBeVisible();
  });
});
