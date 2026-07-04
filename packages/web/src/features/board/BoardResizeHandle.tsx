import { useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import {
  clampBoardColumnWidth,
  clampBoardPhaseHeight,
  MIN_BOARD_COLUMN_WIDTH,
  MIN_BOARD_PHASE_HEIGHT,
} from '@/hooks/useBoardResize';

// Keyboard nudge steps (px). Shift accelerates for coarse adjustment, mirroring
// the schedule task-list resize handle affordance.
const NUDGE = 16;
const NUDGE_COARSE = 48;

/**
 * Read the current rendered size of the handle's positioned parent (the grid
 * track for a column, the lane content grid for a phase). Measuring the live DOM
 * box lets the drag anchor from the real pixel size even when the size is still
 * the zoom-driven CSS-var default (no explicit width persisted yet).
 */
function measureParent(el: HTMLElement, axis: 'width' | 'height'): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const rect = parent.getBoundingClientRect();
  return axis === 'width' ? rect.width : rect.height;
}

interface ColumnResizeHandleProps {
  /** Accessible column label, e.g. "IN PROGRESS". */
  label: string;
  /** Persist a new (unclamped) width; the handle clamps before calling. */
  onResize: (px: number) => void;
}

/**
 * Vertical drag handle on the right edge of a board column header (#285).
 *
 * A 2px grip inside an 8px hit strip that bleeds into the column gap. Pointer
 * drag measures the header cell's current width, then applies the horizontal
 * delta; ArrowLeft/ArrowRight nudge the width for keyboard users. Rendered as a
 * `role="separator"` so assistive tech announces it as a resizer.
 */
export function ColumnResizeHandle({ label, onResize }: ColumnResizeHandleProps) {
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    startXRef.current = e.clientX;
    startWRef.current = measureParent(e.currentTarget, 'width');
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    onResize(clampBoardColumnWidth(startWRef.current + (e.clientX - startXRef.current)));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? NUDGE_COARSE : NUDGE) * (e.key === 'ArrowLeft' ? -1 : 1);
    onResize(clampBoardColumnWidth(measureParent(e.currentTarget, 'width') + step));
  }

  // WAI-ARIA window-splitter pattern: a focusable, keyboard-operable `separator`
  // is the standard resizable-pane idiom (mirrors schedule/ScheduleView). jsx-a11y
  // models `separator` as static, so its focusability rules are disabled here with
  // intent rather than degrading the ARIA semantics.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuemin={MIN_BOARD_COLUMN_WIDTH}
      tabIndex={0}
      data-testid="board-column-resize"
      className="group absolute top-0 bottom-0 right-[-4px] w-2 z-20 flex justify-center
        cursor-col-resize touch-none select-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={[
          'w-0.5 h-full rounded-full transition-colors',
          dragging
            ? 'bg-brand-primary'
            : 'bg-transparent group-hover:bg-brand-primary/40 group-focus-visible:bg-brand-primary',
        ].join(' ')}
      />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}

interface PhaseResizeHandleProps {
  /** Accessible phase name, e.g. "Design". */
  label: string;
  /** Persist a new (unclamped) height; the handle clamps before calling. */
  onResize: (px: number) => void;
}

/**
 * Horizontal drag handle on the bottom edge of a phase lane (#285).
 *
 * A 2px grip inside an 8px hit strip spanning the lane content width. Pointer
 * drag measures the lane's current height, then applies the vertical delta;
 * ArrowUp/ArrowDown nudge the height for keyboard users. Only rendered on an
 * expanded lane (a collapsed lane has no resizable body).
 */
export function PhaseResizeHandle({ label, onResize }: PhaseResizeHandleProps) {
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    startYRef.current = e.clientY;
    startHRef.current = measureParent(e.currentTarget, 'height');
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    onResize(clampBoardPhaseHeight(startHRef.current + (e.clientY - startYRef.current)));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (e.shiftKey ? NUDGE_COARSE : NUDGE) * (e.key === 'ArrowUp' ? -1 : 1);
    onResize(clampBoardPhaseHeight(measureParent(e.currentTarget, 'height') + step));
  }

  // WAI-ARIA window-splitter pattern — see the ColumnResizeHandle note above.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${label} height`}
      aria-valuemin={MIN_BOARD_PHASE_HEIGHT}
      tabIndex={0}
      data-testid="board-phase-resize"
      className="group absolute left-0 right-0 bottom-[-4px] h-2 z-[6] flex items-center
        cursor-row-resize touch-none select-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={[
          'w-full h-0.5 rounded-full transition-colors',
          dragging
            ? 'bg-brand-primary'
            : 'bg-transparent group-hover:bg-brand-primary/40 group-focus-visible:bg-brand-primary',
        ].join(' ')}
      />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
