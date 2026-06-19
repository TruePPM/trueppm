/**
 * BoardZoomControl — board-local zoom stepper (#379, ADR-0145).
 *
 * A −/level/+ stepper (mirroring the Schedule ZoomControl) that steps the board
 * through three discrete spacing levels. The level is applied as CSS custom
 * properties on the board surface by BoardView — this control only reports the
 * selection. Independent axis from board-card Density.
 */
import { type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BoardZoom } from '@/hooks/useBoardToolbarPrefs';

const ORDER: readonly BoardZoom[] = ['small', 'normal', 'large'];
const LABEL: Record<BoardZoom, string> = { small: 'Small', normal: 'Normal', large: 'Large' };

export interface BoardZoomControlProps {
  zoom: BoardZoom;
  onZoomChange: (z: BoardZoom) => void;
}

const STEP_BTN = [
  'flex h-7 w-7 items-center justify-center text-sm text-neutral-text-primary',
  'hover:bg-neutral-surface-raised disabled:opacity-40 disabled:cursor-default',
  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
  'focus-visible:outline-none',
].join(' ');

export function BoardZoomControl({ zoom, onZoomChange }: BoardZoomControlProps) {
  const idx = ORDER.indexOf(zoom);
  const atMin = idx <= 0;
  const atMax = idx >= ORDER.length - 1;
  const zoomOut = () => {
    if (!atMin) onZoomChange(ORDER[idx - 1]);
  };
  const zoomIn = () => {
    if (!atMax) onZoomChange(ORDER[idx + 1]);
  };
  // AC #379: arrow keys change levels. The handler lives on the (interactive)
  // stepper buttons rather than the group wrapper so a screen-reader user
  // tabbed onto either button can step with the arrows.
  const onArrowKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      zoomOut();
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      zoomIn();
      e.preventDefault();
    }
  };

  return (
    <div
      role="group"
      aria-label="Board zoom"
      className="flex h-7 flex-shrink-0 items-center overflow-hidden rounded-full border border-neutral-border bg-neutral-surface"
    >
      <button
        type="button"
        onClick={zoomOut}
        onKeyDown={onArrowKey}
        disabled={atMin}
        aria-label="Zoom out"
        title="Zoom out board"
        className={STEP_BTN}
      >
        −
      </button>
      <span
        role="status"
        aria-live="polite"
        className="min-w-[3.25rem] select-none text-center text-xs font-medium text-neutral-text-secondary"
      >
        {LABEL[zoom]}
      </span>
      <button
        type="button"
        onClick={zoomIn}
        onKeyDown={onArrowKey}
        disabled={atMax}
        aria-label="Zoom in"
        title="Zoom in board"
        className={STEP_BTN}
      >
        +
      </button>
    </div>
  );
}
