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
  it('renders nothing when triggerId is null', () => {
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
});
