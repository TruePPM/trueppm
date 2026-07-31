/**
 * BoardResizeHandle unit tests (issue 285).
 *
 * The two handles (column width, phase-lane height) share one shape, so the
 * suite drives every branch on both axes:
 *   1. the ARIA splitter contract (role/orientation/label/valuemin/focusability)
 *   2. keyboard nudges — both directions × plain vs Shift (coarse) step, the
 *      non-arrow early return, and the clamp floor
 *   3. pointer drag — the `!dragging` guard on move/up, the measured anchor from
 *      the live parent box, delta application, rounding, clamping, the
 *      pointer-capture handshake, and the release-throws recovery path
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { renderWithProviders } from '@/test/utils';
import {
  MAX_BOARD_COLUMN_WIDTH,
  MAX_BOARD_PHASE_HEIGHT,
  MIN_BOARD_COLUMN_WIDTH,
  MIN_BOARD_PHASE_HEIGHT,
} from '@/hooks/useBoardResize';
import { ColumnResizeHandle, PhaseResizeHandle } from './BoardResizeHandle';

/**
 * Render the handle into a host div whose box is stubbed, so `measureParent`
 * reads a real pixel size (jsdom reports 0 for every unstubbed element).
 */
function renderInSizedHost(
  ui: ReactElement,
  { width, height }: { width: number; height: number },
) {
  const host = document.createElement('div');
  host.getBoundingClientRect = (): DOMRect => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  document.body.appendChild(host);
  return renderWithProviders(ui, { container: host });
}

interface CaptureStubs {
  set: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
  release: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
}

/** jsdom implements neither capture method — stub both so the handlers run. */
function stubPointerCapture(el: HTMLElement, releaseThrows = false): CaptureStubs {
  const set = vi.fn<(pointerId: number) => void>();
  const release = vi.fn<(pointerId: number) => void>(() => {
    if (releaseThrows) throw new Error('pointer already released');
  });
  el.setPointerCapture = set;
  el.releasePointerCapture = release;
  return { set, release };
}

/** The 2px grip is the only visible drag-state affordance. */
function grip(handle: HTMLElement): HTMLElement {
  const span = handle.querySelector('span');
  if (!span) throw new Error('grip span not found');
  return span;
}

describe('ColumnResizeHandle — splitter semantics', () => {
  it('exposes the WAI-ARIA vertical splitter contract with the column label', () => {
    const onResize = vi.fn<(px: number) => void>();
    renderInSizedHost(<ColumnResizeHandle label="IN PROGRESS" onResize={onResize} />, {
      width: 300,
      height: 40,
    });

    const handle = screen.getByRole('separator', { name: 'Resize IN PROGRESS column' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_BOARD_COLUMN_WIDTH));
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('renders the grip transparent while idle', () => {
    renderInSizedHost(<ColumnResizeHandle label="TO DO" onResize={vi.fn()} />, {
      width: 300,
      height: 40,
    });

    expect(grip(screen.getByRole('separator')).className).toContain('bg-transparent');
  });
});

describe('ColumnResizeHandle — keyboard nudges', () => {
  let onResize: ReturnType<typeof vi.fn<(px: number) => void>>;

  beforeEach(() => {
    onResize = vi.fn<(px: number) => void>();
  });

  function renderHandle(width: number) {
    renderInSizedHost(<ColumnResizeHandle label="TO DO" onResize={onResize} />, {
      width,
      height: 40,
    });
    return screen.getByRole('separator');
  }

  it('widens by the fine step on ArrowRight', () => {
    const handle = renderHandle(300);

    expect(fireEvent.keyDown(handle, { key: 'ArrowRight' })).toBe(false);
    expect(onResize).toHaveBeenCalledWith(316);
  });

  it('narrows by the fine step on ArrowLeft', () => {
    const handle = renderHandle(300);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });

    expect(onResize).toHaveBeenCalledWith(284);
  });

  it('accelerates to the coarse step when Shift is held', () => {
    const handle = renderHandle(300);

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });

    expect(onResize).toHaveBeenNthCalledWith(1, 348);
    expect(onResize).toHaveBeenNthCalledWith(2, 252);
  });

  it('clamps a narrowing nudge at the minimum column width', () => {
    const handle = renderHandle(MIN_BOARD_COLUMN_WIDTH + 4);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });

    expect(onResize).toHaveBeenCalledWith(MIN_BOARD_COLUMN_WIDTH);
  });

  it('rounds a fractional measured width to a whole pixel', () => {
    const handle = renderHandle(300.4);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(onResize).toHaveBeenCalledWith(316);
  });

  it('ignores the vertical arrows and other keys without preventing default', () => {
    const handle = renderHandle(300);

    expect(fireEvent.keyDown(handle, { key: 'ArrowUp' })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: 'Enter' })).toBe(true);
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('ColumnResizeHandle — pointer drag', () => {
  let onResize: ReturnType<typeof vi.fn<(px: number) => void>>;

  beforeEach(() => {
    onResize = vi.fn<(px: number) => void>();
  });

  function renderHandle(width = 300) {
    renderInSizedHost(<ColumnResizeHandle label="TO DO" onResize={onResize} />, {
      width,
      height: 40,
    });
    return screen.getByRole('separator');
  }

  it('ignores a pointer move that was never preceded by a pointer down', () => {
    const handle = renderHandle();
    stubPointerCapture(handle);

    fireEvent.pointerMove(handle, { clientX: 400 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it('applies the horizontal delta to the measured start width and captures the pointer', () => {
    const handle = renderHandle(300);
    const capture = stubPointerCapture(handle);

    expect(fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 })).toBe(false);
    fireEvent.pointerMove(handle, { clientX: 160 });

    expect(capture.set).toHaveBeenCalledWith(7);
    expect(onResize).toHaveBeenCalledWith(360);
  });

  it('marks the grip active for the duration of the drag', () => {
    const handle = renderHandle();
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    expect(grip(handle).className).toContain('bg-brand-primary');
    expect(grip(handle).className).not.toContain('bg-transparent');

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(grip(handle).className).toContain('bg-transparent');
  });

  it('anchors every move to the original down position, not the previous move', () => {
    const handle = renderHandle(300);
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150 });
    fireEvent.pointerMove(handle, { clientX: 120 });

    expect(onResize).toHaveBeenNthCalledWith(1, 350);
    expect(onResize).toHaveBeenNthCalledWith(2, 320);
  });

  it('clamps a drag that would take the column below the minimum width', () => {
    const handle = renderHandle(220);
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0 });

    expect(onResize).toHaveBeenCalledWith(MIN_BOARD_COLUMN_WIDTH);
  });

  it('rounds a sub-pixel drag delta', () => {
    const handle = renderHandle(300);
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100.6 });

    expect(onResize).toHaveBeenCalledWith(301);
  });

  it('releases the pointer on pointer up and stops responding to later moves', () => {
    const handle = renderHandle(300);
    const capture = stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
    fireEvent.pointerUp(handle, { pointerId: 3 });
    expect(capture.release).toHaveBeenCalledWith(3);

    onResize.mockClear();
    fireEvent.pointerMove(handle, { clientX: 900 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('ignores a pointer up with no drag in flight', () => {
    const handle = renderHandle();
    const capture = stubPointerCapture(handle);

    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(capture.release).not.toHaveBeenCalled();
  });

  it('ends the drag even when releasing the capture throws', () => {
    const handle = renderHandle(300);
    stubPointerCapture(handle, true);

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    expect(() => {
      fireEvent.pointerUp(handle, { pointerId: 1 });
    }).not.toThrow();

    onResize.mockClear();
    fireEvent.pointerMove(handle, { clientX: 900 });
    expect(onResize).not.toHaveBeenCalled();
    expect(grip(handle).className).toContain('bg-transparent');
  });
});

describe('PhaseResizeHandle — splitter semantics', () => {
  it('exposes the WAI-ARIA horizontal splitter contract with the phase label', () => {
    renderInSizedHost(<PhaseResizeHandle label="Design" onResize={vi.fn()} />, {
      width: 800,
      height: 240,
    });

    const handle = screen.getByRole('separator', { name: 'Resize Design height' });
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_BOARD_PHASE_HEIGHT));
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(grip(handle).className).toContain('bg-transparent');
  });
});

describe('PhaseResizeHandle — keyboard nudges', () => {
  let onResize: ReturnType<typeof vi.fn<(px: number) => void>>;

  beforeEach(() => {
    onResize = vi.fn<(px: number) => void>();
  });

  function renderHandle(height: number) {
    renderInSizedHost(<PhaseResizeHandle label="Design" onResize={onResize} />, {
      width: 800,
      height,
    });
    return screen.getByRole('separator');
  }

  it('shortens by the fine step on ArrowUp', () => {
    const handle = renderHandle(240);

    expect(fireEvent.keyDown(handle, { key: 'ArrowUp' })).toBe(false);
    expect(onResize).toHaveBeenCalledWith(224);
  });

  it('grows by the fine step on ArrowDown', () => {
    const handle = renderHandle(240);

    fireEvent.keyDown(handle, { key: 'ArrowDown' });

    expect(onResize).toHaveBeenCalledWith(256);
  });

  it('accelerates to the coarse step when Shift is held', () => {
    const handle = renderHandle(240);

    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'ArrowUp', shiftKey: true });

    expect(onResize).toHaveBeenNthCalledWith(1, 288);
    expect(onResize).toHaveBeenNthCalledWith(2, 192);
  });

  it('clamps a shortening nudge at the minimum phase height', () => {
    const handle = renderHandle(MIN_BOARD_PHASE_HEIGHT + 4);

    fireEvent.keyDown(handle, { key: 'ArrowUp' });

    expect(onResize).toHaveBeenCalledWith(MIN_BOARD_PHASE_HEIGHT);
  });

  it('ignores the horizontal arrows and other keys without preventing default', () => {
    const handle = renderHandle(240);

    expect(fireEvent.keyDown(handle, { key: 'ArrowLeft' })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: 'ArrowRight' })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: ' ' })).toBe(true);
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('PhaseResizeHandle — pointer drag', () => {
  let onResize: ReturnType<typeof vi.fn<(px: number) => void>>;

  beforeEach(() => {
    onResize = vi.fn<(px: number) => void>();
  });

  function renderHandle(height = 240) {
    renderInSizedHost(<PhaseResizeHandle label="Design" onResize={onResize} />, {
      width: 800,
      height,
    });
    return screen.getByRole('separator');
  }

  it('ignores a pointer move that was never preceded by a pointer down', () => {
    const handle = renderHandle();
    stubPointerCapture(handle);

    fireEvent.pointerMove(handle, { clientY: 400 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it('applies the vertical delta to the measured start height and captures the pointer', () => {
    const handle = renderHandle(240);
    const capture = stubPointerCapture(handle);

    expect(fireEvent.pointerDown(handle, { clientY: 500, pointerId: 9 })).toBe(false);
    fireEvent.pointerMove(handle, { clientY: 560 });

    expect(capture.set).toHaveBeenCalledWith(9);
    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('marks the grip active for the duration of the drag', () => {
    const handle = renderHandle();
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    expect(grip(handle).className).toContain('bg-brand-primary');

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(grip(handle).className).toContain('bg-transparent');
  });

  it('clamps a drag that would take the lane below the minimum height', () => {
    const handle = renderHandle(140);
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 0 });

    expect(onResize).toHaveBeenCalledWith(MIN_BOARD_PHASE_HEIGHT);
  });

  it('releases the pointer on pointer up and stops responding to later moves', () => {
    const handle = renderHandle(240);
    const capture = stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 4 });
    fireEvent.pointerUp(handle, { pointerId: 4 });
    expect(capture.release).toHaveBeenCalledWith(4);

    onResize.mockClear();
    fireEvent.pointerMove(handle, { clientY: 900 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('ignores a pointer up with no drag in flight', () => {
    const handle = renderHandle();
    const capture = stubPointerCapture(handle);

    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(capture.release).not.toHaveBeenCalled();
  });

  it('ends the drag even when releasing the capture throws', () => {
    const handle = renderHandle(240);
    stubPointerCapture(handle, true);

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    expect(() => {
      fireEvent.pointerUp(handle, { pointerId: 1 });
    }).not.toThrow();

    onResize.mockClear();
    fireEvent.pointerMove(handle, { clientY: 900 });
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('window-splitter ARIA (#2635)', () => {
  // A focusable role="separator" IS a WAI-ARIA window splitter, and aria-valuenow
  // is REQUIRED on one. Both handles declared aria-valuemin and nothing else, so
  // axe raised aria-required-attr — the failure the Board's exclusion masked while
  // citing an issue (#2204) that had already closed. The gate was green partly by
  // hiding a live WCAG 4.1.2 violation that no open issue tracked.
  it('the column handle declares a complete, coherent value range', () => {
    renderInSizedHost(<ColumnResizeHandle label="In Progress" onResize={vi.fn()} />, {
      width: 320,
      height: 400,
    });
    const handle = screen.getByTestId('board-column-resize');

    expect(handle).toHaveAttribute('aria-valuenow', '320');
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_BOARD_COLUMN_WIDTH));
    expect(handle).toHaveAttribute('aria-valuemax', String(MAX_BOARD_COLUMN_WIDTH));
    expect(handle).toHaveAttribute('aria-valuetext', 'In Progress column 320 pixels');
    // min < max, or the announced range is nonsense. Omitting aria-valuemax would
    // have defaulted it to 100 — below the 200px minimum.
    expect(MIN_BOARD_COLUMN_WIDTH).toBeLessThan(MAX_BOARD_COLUMN_WIDTH);
  });

  it('the phase handle declares a complete, coherent value range', () => {
    renderInSizedHost(<PhaseResizeHandle label="Design" onResize={vi.fn()} />, {
      width: 600,
      height: 240,
    });
    const handle = screen.getByTestId('board-phase-resize');

    expect(handle).toHaveAttribute('aria-valuenow', '240');
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_BOARD_PHASE_HEIGHT));
    expect(handle).toHaveAttribute('aria-valuemax', String(MAX_BOARD_PHASE_HEIGHT));
    expect(MIN_BOARD_PHASE_HEIGHT).toBeLessThan(MAX_BOARD_PHASE_HEIGHT);
  });

  it('keyboard nudging keeps the announced value in step with the persisted one', () => {
    // An aria-valuenow that never updates is worse than none: it asserts a size the
    // splitter no longer has.
    const onResize = vi.fn();
    renderInSizedHost(<ColumnResizeHandle label="In Progress" onResize={onResize} />, {
      width: 320,
      height: 400,
    });
    const handle = screen.getByTestId('board-column-resize');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(onResize).toHaveBeenCalledTimes(1);
    const persisted = onResize.mock.calls[0][0] as number;
    expect(handle).toHaveAttribute('aria-valuenow', String(persisted));
  });
});
