import type { Task } from '@/types';
import { severityRagBand } from '@/hooks/useTaskDependencies';

/**
 * Get initials from a full name — at most two chars.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format an entry-stamp line and compute dwell time.
 * Returns daysAgo for use by the SLA aging indicator (issue 192).
 */
export function entryStamp(task: Task): {
  text: string;
  isStalled: boolean;
  daysAgo: number | null;
} {
  if (!task.statusEnteredAt) {
    return { text: '', isStalled: false, daysAgo: null };
  }

  // dwell + the stalled verdict are server-owned (issue 992, ADR-0115): the API returns
  // dwell_days (the raw fact) and is_stalled (the verdict). Fall back to a client
  // derivation only for tasks not carrying the server fields yet (legacy fixtures /
  // optimistic rows) so the stamp never blanks mid-migration.
  const enteredMs = new Date(task.statusEnteredAt).getTime();
  const derivedDays = Math.floor((Date.now() - enteredMs) / 86_400_000);
  const daysAgo = task.dwellDays ?? derivedDays;
  const daysLabel = daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;

  // COMPLETE implies 100% regardless of the stored progress value, so the
  // entry stamp matches the column it lives in.  Stalled is also a no-op on
  // DONE — a card sitting in DONE for weeks isn't "stalled," it's finished.
  const effectiveProgress = task.status === 'COMPLETE' ? 100 : task.progress;
  const isStalled =
    task.isStalled ?? (task.status !== 'COMPLETE' && daysAgo > 3 && effectiveProgress < 100);

  return {
    text: `Entered at ${effectiveProgress}% · ${daysLabel}${isStalled ? ' — stalled' : ''}`,
    isStalled,
    daysAgo,
  };
}

/** Format a currency value compactly (e.g. 125000 → "$125K"). */
export function fmtCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

// Left accent bar color per readiness state (issue 179).
// CP (critical) overrides all; at-risk overrides estimated/ready/baselined.
// `showCriticalState` gates the red CP override so backlog/uncommitted tasks
// don't display scheduled-state styling (issue 332).
export function accentBarClass(task: Task, showCriticalState: boolean): string {
  if (showCriticalState) return 'bg-semantic-critical';
  const r = task.readiness ?? 'estimated';
  switch (r) {
    case 'idea':
      return 'bg-transparent';
    case 'baselined':
      return 'bg-semantic-on-track';
    default:
      return 'bg-brand-primary';
  }
}

/** Tooltip text for a critical-path task (issue 181 / WCAG 1.4.1). */
export function cpTooltip(_task: Task): string {
  return 'On critical path — any delay here will delay the project end date';
}

// Chip tone (bg + border + text) for the inline risk signal chip — maps the
// 5-tier severity register down to a 3-tier RAG palette (ADR-0035 §Q2; full
// breakdown lives in the RiskPopover for color-blind safety), matching the
// float/SPI chip tone patterns so the in-flow signal chips read as one
// calm family.
export function riskChipToneClass(severity: number | null | undefined): string {
  const band = severityRagBand(severity);
  switch (band) {
    case 'red':
      return 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical';
    case 'amber':
      return 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark';
    case 'green':
      return 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track';
    default:
      return 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary';
  }
}

/** Title text/tone classes shared by the compact bar and the wrapped title. */
export function cardTitleToneClass(showCriticalState: boolean, isIdea: boolean): string {
  if (showCriticalState) return 'text-semantic-critical font-semibold';
  if (isIdea) return 'text-neutral-text-disabled italic';
  return 'text-neutral-text-primary';
}
