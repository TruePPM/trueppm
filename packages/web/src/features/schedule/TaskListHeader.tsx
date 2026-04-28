import { useRef, type PointerEvent } from 'react';
import type { ColumnKey, ColumnWidths } from '@/hooks/useColumnWidths';

interface ResizeHandleProps {
  colKey: ColumnKey;
  setWidth: ColumnWidths['setWidth'];
  currentWidth: number;
}

function ResizeHandle({ colKey, setWidth, currentWidth }: ResizeHandleProps) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(currentWidth);

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

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${colKey} column`}
      className="absolute right-0 top-0 bottom-0 w-3 cursor-col-resize z-10 flex items-center justify-end group"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Indicator at right-0 of the hit zone — aligns with border-r on data rows */}
      <div className="w-px h-full bg-white/30 group-hover:bg-brand-primary/80 transition-colors" aria-hidden="true" />
    </div>
  );
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
          className="text-right shrink-0 pr-2"
          style={{ width: widths.progress }}
          role="columnheader"
          aria-label="Progress"
        >
          %
        </span>
      )}
    </div>
  );
}
