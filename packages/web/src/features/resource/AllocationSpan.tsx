/**
 * A single task span in the resource allocation timeline (issue #85, ADR-0031).
 *
 * Variants:
 *   normal   — bg-brand-primary, full-time (units ≥ 1.0, no conflict)
 *   partial  — brand bg + diagonal stripe overlay (units < 1.0)
 *   over     — semantic-critical bg (resource is overallocated on ≥ 1 day)
 *   complete — muted (task status === COMPLETE)
 *
 * Width and left offset are computed by the parent from the window geometry.
 * Labels are hidden when widthPx < 48; tooltip always present.
 */
import { WarningIcon } from '@/components/Icons';
import { useRef } from 'react';
import type { AllocationTask } from './resourceUtils';

export type SpanVariant = 'normal' | 'partial' | 'over' | 'complete';

interface Props {
  task: AllocationTask;
  variant: SpanVariant;
  /** 0–1 fraction from window start */
  leftFraction: number;
  /** 0–1 fraction of window width */
  widthFraction: number;
  /** Container pixel width (used to decide label visibility) */
  containerWidth: number;
  onEdit: (assignmentId: string) => void;
}

const VARIANT_BG: Record<SpanVariant, string> = {
  normal: 'bg-brand-primary',
  partial: 'bg-brand-primary',
  over: 'bg-semantic-critical',
  complete: 'bg-neutral-border',
};

const VARIANT_TEXT: Record<SpanVariant, string> = {
  normal: 'text-white',
  partial: 'text-white',
  over: 'text-white',
  complete: 'text-neutral-text-secondary',
};

export function AllocationSpan({
  task,
  variant,
  leftFraction,
  widthFraction,
  containerWidth,
  onEdit,
}: Props) {
  const spanRef = useRef<HTMLButtonElement>(null);
  const spanPx = widthFraction * containerWidth;
  const showLabel = spanPx >= 48;
  const unitsDisplay = `${Math.round(parseFloat(task.units) * 100)}%`;

  const tooltipLabel = [
    task.name,
    `${unitsDisplay} allocation`,
    task.early_start && task.early_finish
      ? `${task.early_start} – ${task.early_finish}`
      : 'unscheduled',
    variant === 'over' ? '⚠ overallocated' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const ariaLabel = [
    `Edit allocation for ${task.name}`,
    `${unitsDisplay}`,
    task.early_start && task.early_finish
      ? `${task.early_start} to ${task.early_finish}`
      : 'unscheduled',
    variant === 'over' ? 'overallocated' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <button
      ref={spanRef}
      type="button"
      aria-label={ariaLabel}
      title={tooltipLabel}
      onClick={() => onEdit(task.assignment_id)}
      className={[
        'absolute top-[7px] h-[26px] rounded flex items-center px-1.5 overflow-hidden',
        'text-xs font-semibold whitespace-nowrap',
        'transition-[filter] duration-100 hover:brightness-90',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        VARIANT_BG[variant],
        VARIANT_TEXT[variant],
        variant === 'over' ? 'ring-[1.5px] ring-inset ring-semantic-critical/70' : '',
        variant === 'complete' ? 'opacity-60' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: `${leftFraction * 100}%`,
        width: `${widthFraction * 100}%`,
        // Partial allocation: diagonal stripe overlay
        ...(variant === 'partial'
          ? {
              backgroundImage:
                'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.13) 4px, rgba(0,0,0,0.13) 8px)',
            }
          : {}),
      }}
    >
      {showLabel && (
        <>
          <span className="truncate flex-1 min-w-0">
            {variant === 'over' && <WarningIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />}
            {task.name}
            {task.status === 'COMPLETE' && ' ✓'}
          </span>
          <span className="ml-1 opacity-80 flex-shrink-0">{unitsDisplay}</span>
        </>
      )}
    </button>
  );
}
