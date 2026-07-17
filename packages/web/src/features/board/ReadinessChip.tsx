import { LockIcon } from '@/components/Icons';
import type { TaskReadiness } from '@/types';

interface ReadinessChipProps {
  readiness: TaskReadiness;
  /**
   * `full` (default): labeled pill with a non-color glyph per state — used on the
   * board card, the unscheduled gutter, and the task drawer header.
   * `compact`: an uppercase micro-chip for dense backlog / queue rows, where the
   * label alone carries the signal in a smaller footprint.
   */
  variant?: 'full' | 'compact';
}

// Compact variant: uppercase micro-chip. Color is a supporting cue only — the
// uppercase state word is the primary signal (web-rule 107). `ready` uses the
// brand-primary-light token, which is a channel-triple CSS var (ADR-0103) with
// no clean single-class Tailwind mapping, so it is applied as an inline rgb().
const COMPACT_STYLE: Record<TaskReadiness, string> = {
  idea: 'border border-dashed border-neutral-border text-neutral-text-disabled',
  estimated: 'bg-neutral-surface-sunken text-neutral-text-secondary',
  ready: 'text-brand-primary',
  baselined: 'bg-neutral-surface-sunken text-neutral-text-secondary',
};

function CompactReadinessChip({ readiness }: { readiness: TaskReadiness }) {
  const inlineBg = readiness === 'ready' ? 'rgb(var(--brand-primary-light))' : undefined;
  return (
    <span
      className={`inline-flex items-center rounded-chip uppercase tracking-wider font-semibold ${COMPACT_STYLE[readiness]}`}
      style={{
        height: 16,
        padding: '0 6px',
        fontSize: '10px',
        letterSpacing: '0.06em',
        backgroundColor: inlineBg,
      }}
    >
      {readiness}
    </span>
  );
}

/**
 * Readiness pill (issue #179) — the at-a-glance "how baked is this work item?"
 * signal. Shared by the board card (top-left), the unscheduled gutter, the task
 * detail drawer header (#962), the card popover, and the backlog / queue rows.
 * Four states with a non-color signal each (dashed border / glyph / label) so
 * readiness never relies on color alone (web-rule 107).
 */
export function ReadinessChip({ readiness, variant = 'full' }: ReadinessChipProps) {
  if (variant === 'compact') return <CompactReadinessChip readiness={readiness} />;
  switch (readiness) {
    case 'idea':
      return (
        <span className="inline-flex items-center px-1.5 py-px rounded-chip border border-dashed border-neutral-border text-xs text-neutral-text-disabled">
          idea
        </span>
      );
    case 'estimated':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-chip bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary">
          <span aria-hidden="true">·</span> estimated
        </span>
      );
    case 'ready':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-chip bg-brand-primary/10 dark:bg-semantic-on-track-bg border border-brand-primary/30 dark:border-semantic-on-track/30 text-xs text-brand-primary dark:text-semantic-on-track font-medium">
          <span aria-hidden="true">⛓</span> ready
        </span>
      );
    case 'baselined':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-chip bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary font-medium">
          <LockIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" /> baselined
        </span>
      );
  }
}
