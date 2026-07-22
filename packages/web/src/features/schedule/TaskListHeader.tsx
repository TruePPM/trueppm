import { useRef, type PointerEvent, type KeyboardEvent } from 'react';
import { MIN_COL_WIDTHS, type ColumnKey, type ColumnWidths } from '@/hooks/useColumnWidths';

interface ResizeHandleProps {
  colKey: ColumnKey;
  setWidth: ColumnWidths['setWidth'];
  currentWidth: number;
}

// Keyboard-only upper guidance; the store clamps the lower bound to
// MIN_COL_WIDTHS but enforces no max, so this bounds Home/End + arrow nudges.
const MAX_COL_WIDTH = 400;

function ResizeHandle({ colKey, setWidth, currentWidth }: ResizeHandleProps) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(currentWidth);
  const min = MIN_COL_WIDTHS[colKey];

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = currentWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (startXRef.current === null) return;
    const delta = e.clientX - startXRef.current;
    setWidth(colKey, startWidthRef.current + delta);
  }

  function onPointerUp() {
    startXRef.current = null;
  }

  // Keyboard-operable alternative to pointer drag (WCAG 2.1.1), mirroring the
  // panel splitter in ScheduleView: arrows nudge 16px, Home/End jump to min/max.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = currentWidth - 16;
    else if (e.key === 'ArrowRight') next = currentWidth + 16;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = MAX_COL_WIDTH;
    if (next === null) return;
    e.preventDefault();
    setWidth(colKey, Math.min(MAX_COL_WIDTH, Math.max(min, next)));
  }

  // WAI-ARIA window-splitter: a focusable `separator` exposing aria-valuenow is
  // the standard keyboard-operable resize idiom. jsx-a11y models `separator` as
  // static, so its focusability/interaction lints are disabled here with intent
  // (mirrors PanelSplitter in ScheduleView).
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${colKey} column`}
      tabIndex={0}
      aria-valuenow={Math.round(currentWidth)}
      aria-valuemin={min}
      aria-valuemax={MAX_COL_WIDTH}
      aria-valuetext={`${colKey} column ${Math.round(currentWidth)} pixels`}
      className="absolute right-0 top-0 bottom-0 w-3 cursor-col-resize z-10 flex items-center justify-end group focus-visible:outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {/* Indicator at right-0 of the hit zone — aligns with border-r on data
          rows. Rests on the neutral divider token (≥3:1, WCAG 1.4.11); brand
          on hover/focus. `bg-white/30` failed non-text contrast (#2205). */}
      <div
        className="w-px h-full bg-neutral-border group-hover:bg-brand-primary group-focus-visible:bg-brand-primary transition-colors"
        aria-hidden="true"
      />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}

interface Props {
  widths: ColumnWidths['widths'];
  visible: ColumnWidths['visible'];
  setWidth: ColumnWidths['setWidth'];
}

export function TaskListHeader({ widths, visible, setWidth }: Props) {
  return (
    <div
      className="flex items-center h-7 bg-neutral-surface border-b border-neutral-border
        text-xs font-medium text-neutral-text-secondary select-none sticky top-0 z-10"
      role="row"
      aria-label="Task list columns"
    >
      {/* WBS column (#248) — leftmost; right-aligned dot-path numbering */}
      {visible.wbs && (
        <span
          className="relative text-right shrink-0 pr-2 border-r border-neutral-border/20"
          style={{ width: widths.wbs }}
          role="columnheader"
          aria-label="Work breakdown structure"
        >
          WBS
          <ResizeHandle colKey="wbs" setWidth={setWidth} currentWidth={widths.wbs} />
        </span>
      )}

      {/* Task column — always visible; pl-2 keeps text inset from the left edge */}
      <span
        className="relative pl-2 truncate shrink-0"
        style={{ width: widths.task }}
        role="columnheader"
      >
        Task
        <ResizeHandle colKey="task" setWidth={setWidth} currentWidth={widths.task} />
      </span>

      {visible.dur && (
        <span
          className="relative text-right shrink-0 pr-2"
          style={{ width: widths.dur }}
          role="columnheader"
          aria-label="Duration"
        >
          Dur
          <ResizeHandle colKey="dur" setWidth={setWidth} currentWidth={widths.dur} />
        </span>
      )}

      {visible.start && (
        <span
          className="relative text-right shrink-0 pr-2"
          style={{ width: widths.start }}
          role="columnheader"
          aria-label="Start date"
        >
          Start
          <ResizeHandle colKey="start" setWidth={setWidth} currentWidth={widths.start} />
        </span>
      )}

      {visible.finish && (
        <span
          className="relative text-right shrink-0 pr-2"
          style={{ width: widths.finish }}
          role="columnheader"
          aria-label="Finish date"
        >
          Finish
          <ResizeHandle colKey="finish" setWidth={setWidth} currentWidth={widths.finish} />
        </span>
      )}

      {visible.progress && (
        <span
          className="relative text-right shrink-0 pr-2"
          style={{ width: widths.progress }}
          role="columnheader"
          aria-label="Progress"
        >
          %
          <ResizeHandle colKey="progress" setWidth={setWidth} currentWidth={widths.progress} />
        </span>
      )}

      {/* Owner avatar column (#248) — rightmost; left-aligned for vertical scan */}
      {visible.owner && (
        <span
          className="relative pl-2 shrink-0"
          style={{ width: widths.owner }}
          role="columnheader"
          aria-label="Owner"
        >
          Owner
          <ResizeHandle colKey="owner" setWidth={setWidth} currentWidth={widths.owner} />
        </span>
      )}
    </div>
  );
}
