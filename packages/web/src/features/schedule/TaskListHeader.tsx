import { useRef, type PointerEvent, type KeyboardEvent } from 'react';
import { MIN_COL_WIDTHS, type ColumnKey, type ColumnWidths } from '@/hooks/useColumnWidths';

interface ResizeHandleProps {
  colKey: ColumnKey;
  setWidth: ColumnWidths['setWidth'];
  currentWidth: number;
  /**
   * Upper bound for this column, when the host has one (#2960).
   *
   * Only the Task column gets one, and only because it has a **second writer**:
   * `ScheduleView`'s `PanelSplitter` resizes the same persisted value against
   * the room the bar track needs. Before #2960 this handle's pointer path was
   * unbounded and its keyboard path stopped at a local constant, so the
   * splitter's container-aware clamp was defeated by the wider hit zone one row
   * above it — and the two separators announced different `aria-valuemax` for
   * one quantity, which is a WCAG 4.1.2 failure nothing visual catches.
   */
  maxWidth?: number;
}

// Upper bound for a column with no second writer. The store clamps the lower
// bound to MIN_COL_WIDTHS but enforces no max, so this bounds the pointer drag
// as well as Home/End + arrow nudges.
const MAX_COL_WIDTH = 400;

function ResizeHandle({ colKey, setWidth, currentWidth, maxWidth }: ResizeHandleProps) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(currentWidth);
  const min = MIN_COL_WIDTHS[colKey];
  // Never below the width already held: an upper bound is permission to grow,
  // not an instruction to shrink, and a bound that reaches backwards would both
  // announce `valuemax < valuenow` and collapse the column on first contact.
  const max = Math.max(maxWidth ?? MAX_COL_WIDTH, currentWidth, min);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = currentWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (startXRef.current === null) return;
    const delta = e.clientX - startXRef.current;
    // Same clamp as the keyboard path below, and — for Task — the same one the
    // panel splitter uses. A pointer path that can reach a width the keyboard
    // refuses is the bound's escape hatch, not its implementation.
    setWidth(colKey, clamp(startWidthRef.current + delta));
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
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    setWidth(colKey, clamp(next));
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
      aria-valuemax={Math.round(max)}
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
  /**
   * Width of the ⋮⋮ grip's lane (#2997) — 0 unless the outline is authorable on
   * a coarse pointer. Taken from `TaskListPanel` rather than resolved here, so
   * the header and the rows cannot answer the question differently and leave
   * the columns 44px out of step.
   */
  gripReserve: number;
  /** Shared upper bound for the Task column — see `ResizeHandle` (#2960). */
  maxTaskWidth?: number;
}

export function TaskListHeader({ widths, visible, setWidth, gripReserve, maxTaskWidth }: Props) {
  return (
    <div
      className="flex items-center h-7 bg-neutral-surface border-b border-neutral-border
        text-xs font-medium text-neutral-text-secondary select-none sticky top-0 z-10"
      role="row"
      aria-rowindex={1}
      aria-label="Task list columns"
    >
      {gripReserve > 0 && (
        <span aria-hidden="true" className="shrink-0" style={{ width: gripReserve }} />
      )}

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
        <ResizeHandle
          colKey="task"
          setWidth={setWidth}
          currentWidth={widths.task}
          maxWidth={maxTaskWidth}
        />
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
