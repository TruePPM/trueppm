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
      className="absolute right-0 top-0 bottom-0 w-3 cursor-col-resize z-10 flex items-center justify-center group"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="w-px h-3.5 bg-white/20 group-hover:bg-brand-primary transition-colors" aria-hidden="true" />
    </div>
  );
}

interface Props {
  widths: ColumnWidths['widths'];
  setWidth: ColumnWidths['setWidth'];
}

export function TaskListHeader({ widths, setWidth }: Props) {
  return (
    <div
      className="flex items-center h-7 px-2 bg-gantt-surface border-b border-neutral-border/30
        text-xs font-medium text-gantt-text-secondary select-none sticky top-0 z-10"
      role="row"
      aria-label="Task list columns"
    >
      {/* Task column — flex-1 is replaced by explicit width so resize is consistent */}
      <span
        className="relative truncate shrink-0"
        style={{ width: widths.task }}
        role="columnheader"
      >
        Task
        <ResizeHandle colKey="task" setWidth={setWidth} currentWidth={widths.task} />
      </span>

      <span
        className="relative text-right shrink-0"
        style={{ width: widths.duration }}
        role="columnheader"
        aria-label="Duration"
      >
        Dur
        <ResizeHandle colKey="duration" setWidth={setWidth} currentWidth={widths.duration} />
      </span>

      <span
        className="relative text-right shrink-0"
        style={{ width: widths.start }}
        role="columnheader"
        aria-label="Start date"
      >
        Start
        <ResizeHandle colKey="start" setWidth={setWidth} currentWidth={widths.start} />
      </span>

      <span
        className="text-right shrink-0"
        style={{ width: widths.progress }}
        role="columnheader"
        aria-label="Progress"
      >
        %
      </span>
    </div>
  );
}
