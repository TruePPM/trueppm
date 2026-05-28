interface UnscheduledDropIndicatorProps {
  x: number;
  canvasRect: DOMRect;
  dateLabel: string;
}

/**
 * Vertical drop guide line + date pill overlaid on the canvas during a gutter drag.
 * Positioned using canvas bounding rect + pointer X from GanttScaleData.
 * pointer-events-none aria-hidden — never intercepts events (rule 27).
 */
export function UnscheduledDropIndicator({ x, canvasRect, dateLabel }: UnscheduledDropIndicatorProps) {
  const lineX = canvasRect.left + x;

  return (
    <div
      aria-hidden="true"
      data-testid="schedule-drop-indicator"
      style={{ position: 'fixed', left: lineX, top: canvasRect.top, height: canvasRect.height, pointerEvents: 'none', zIndex: 9998 }}
    >
      {/* Vertical guide line */}
      <div className="w-px h-full bg-brand-primary" />
      {/* Date pill above the line */}
      <div
        className="absolute -top-6 left-1/2 -translate-x-1/2 tppm-mono text-xs px-2 py-0.5
          bg-brand-primary text-white rounded whitespace-nowrap"
      >
        {dateLabel}
      </div>
    </div>
  );
}
