/**
 * LaneMeta — left-rail atom for each phase swimlane on the Board (issue #208).
 *
 * Anatomy (188px wide):
 *   ▌  Phase name                          [+]
 *   ▌  ⊕ 55%
 *   ▌    8 tasks
 *
 * Workshop variant (`workshop={true}`): background tinted with phase color,
 * phase name becomes contentEditable, drag handle rendered (wiring is N19).
 */
import type { ReactNode } from 'react';

const SIZE = 36;
const STROKE_WIDTH = 3;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface RingProps {
  avg: number;
}

function ProgressRing({ avg }: RingProps) {
  const pct = Math.max(0, Math.min(100, avg));
  const dashOffset = CIRCUMFERENCE * (1 - pct / 100);

  const strokeClass =
    pct === 0
      ? 'stroke-neutral-border'
      : pct >= 50
        ? 'stroke-semantic-on-track'
        : 'stroke-brand-accent';

  return (
    <svg
      aria-hidden="true"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="flex-shrink-0"
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE_WIDTH}
        className="stroke-neutral-surface-sunken"
      />
      {pct > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          className={strokeClass}
        />
      )}
    </svg>
  );
}

export interface LaneMetaProps {
  phaseId: string;
  phaseName: string;
  /** 0–100 average progress across all tasks in this phase. */
  avgProgress: number;
  taskCount: number;
  /** Hex color for the 3px left rail; use phaseColor() helper to derive. */
  railColor: string;
  /** Workshop mode: tinted bg, editable name, drag handle. */
  workshop?: boolean;
  onAddTask?: () => void;
  /** Expand/collapse toggle rendered inside the phase name row. */
  collapseToggle?: ReactNode;
}

export function LaneMeta({
  phaseId,
  phaseName,
  avgProgress,
  taskCount,
  railColor,
  workshop = false,
  onAddTask,
  collapseToggle,
}: LaneMetaProps) {
  const pct = Math.max(0, Math.min(100, avgProgress));

  return (
    <div
      className="relative"
      style={workshop ? { background: `color-mix(in srgb, ${railColor} 5%, var(--neutral-surface, white))` } : undefined}
    >
      {/* 3px color rail */}
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: railColor }}
      />

      {/* Content — inset from rail */}
      <div className="pl-[11px] pr-[14px] pt-[14px] pb-[14px] flex flex-col gap-2" style={{ minHeight: 88 }}>

        {/* Header row: name + add button */}
        <div className="flex items-center gap-2 min-w-0">
          {workshop && (
            <span
              aria-hidden="true"
              className="text-neutral-text-disabled text-sm cursor-grab select-none flex-shrink-0"
              title="Drag to reorder phase"
            >
              ⋮⋮
            </span>
          )}

          {collapseToggle}

          {workshop ? (
            <span
              role="textbox"
              contentEditable
              suppressContentEditableWarning
              aria-label={`Phase name: ${phaseName}`}
              className="flex-1 text-xs font-semibold text-neutral-text-primary truncate
                outline-none border border-dashed border-neutral-border rounded px-[6px] py-[3px]
                bg-neutral-surface focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              {phaseName}
            </span>
          ) : (
            <span className="flex-1 text-xs font-semibold text-neutral-text-primary truncate">
              {phaseName}
            </span>
          )}

          <button
            type="button"
            onClick={onAddTask}
            title={`Add task to ${phaseName}`}
            aria-label={`Add task to ${phaseName}`}
            data-testid={`add-task-${phaseId}`}
            className="flex-shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded
              border border-neutral-border bg-neutral-surface text-neutral-text-secondary
              hover:border-brand-primary/50 hover:text-brand-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
          </button>
        </div>

        {/* Progress block */}
        <div className="flex items-center gap-2">
          <ProgressRing avg={pct} />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-neutral-text-primary font-mono leading-none">
              {pct}%
            </span>
            <span className="text-[10px] text-neutral-text-secondary leading-tight mt-0.5">
              {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
