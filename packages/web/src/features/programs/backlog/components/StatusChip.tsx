/**
 * Pill for a backlog item's status. PULLED uses the brand-green selection
 * color (per tokens); PROPOSED is a neutral outline; ARCHIVED is muted. The
 * status word is always present, so the chip reads correctly without color.
 */

import type { BacklogItemStatus } from '../types';

const STATUS_STYLES: Record<BacklogItemStatus, { label: string; className: string }> = {
  PROPOSED: {
    label: 'Proposed',
    className: 'border border-neutral-border bg-neutral-surface text-neutral-text-secondary',
  },
  PULLED: {
    label: 'Pulled',
    className: 'border border-brand-primary bg-brand-primary-light text-brand-primary-dark',
  },
  ARCHIVED: {
    label: 'Archived',
    className: 'border border-neutral-border bg-neutral-surface-sunken text-neutral-text-disabled',
  },
};

interface StatusChipProps {
  status: BacklogItemStatus;
  className?: string;
}

export function StatusChip({ status, className = '' }: StatusChipProps) {
  const { label, className: tone } = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex h-[18px] items-center rounded-full px-2 text-xs font-medium
        leading-none ${tone} ${className}`}
    >
      {label}
    </span>
  );
}
