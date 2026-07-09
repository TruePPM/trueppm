import { LockIcon } from '@/components/Icons';
import type { TaskReadiness } from '@/types';

/**
 * Readiness pill (issue #179) — the at-a-glance "how baked is this work item?"
 * signal. Shared by the board card (top-left), the unscheduled gutter, and the
 * task detail drawer header (#962). Four states with a non-color signal each
 * (dashed border / glyph / label) so readiness never relies on color alone
 * (web-rule 107).
 */
export function ReadinessChip({ readiness }: { readiness: TaskReadiness }) {
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
