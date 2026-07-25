import type { TaskStatus } from '@/types';

export const COLUMN_TINT: Partial<Record<TaskStatus, string>> = {
  COMPLETE: 'bg-semantic-on-track/[0.025]',
  REVIEW: 'bg-brand-accent/5',
  BACKLOG: 'bg-neutral-text-disabled/5',
};

// Status-dot color per column (epic #361 child E, issue #385).
// Drives the 6px dot prefix on each column header — a non-color label is
// always present, so the dot is `aria-hidden`. BACKLOG is mapped for
// completeness but never renders in the current grid (ADR-0057 lifted it
// into the band).
export const COLUMN_DOT_CLASS: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-text-disabled',
  NOT_STARTED: 'bg-neutral-text-disabled',
  IN_PROGRESS: 'bg-brand-primary',
  REVIEW: 'bg-brand-accent',
  ON_HOLD: 'bg-neutral-text-disabled',
  COMPLETE: 'bg-semantic-on-track',
};

// Board zoom (issue 379, ADR-0145). Each level sets coordinated CSS custom properties
// on the board grid container; the column-header / lane / phase-rail grids read
// --board-phase-col and --board-col-gap, and the column card-stack reads
// --board-card-gap. `normal` reproduces the pre-zoom defaults exactly (188px /
// gap-2 / gap-1.5) so the default board is visually unchanged. dnd-kit-safe:
// these are real CSS sizes, not a transform/zoom that would break drag math.
