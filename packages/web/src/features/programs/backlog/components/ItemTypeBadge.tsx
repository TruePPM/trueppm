/**
 * Outline-pill badge for a backlog item's type.
 *
 * Hue is drawn only from the existing design tokens (brand green / amber /
 * critical red / neutral) — no new colors. The label always renders, so the
 * badge never relies on color alone to convey meaning (WCAG 1.4.1).
 */

import type { BacklogItemType } from '../types';

const TYPE_STYLES: Record<BacklogItemType, { label: string; className: string }> = {
  epic: { label: 'Epic', className: 'border-brand-primary text-brand-primary' },
  feature: { label: 'Feature', className: 'border-brand-primary text-brand-primary' },
  story: { label: 'Story', className: 'border-neutral-border text-neutral-text-secondary' },
  task: { label: 'Task', className: 'border-neutral-border text-neutral-text-secondary' },
  spike: { label: 'Spike', className: 'border-brand-accent-dark text-brand-accent-dark' },
  chore: { label: 'Chore', className: 'border-neutral-border text-neutral-text-disabled' },
  bug: { label: 'Bug', className: 'border-semantic-critical text-semantic-critical' },
};

interface ItemTypeBadgeProps {
  type: BacklogItemType;
  className?: string;
}

export function ItemTypeBadge({ type, className = '' }: ItemTypeBadgeProps) {
  const { label, className: tone } = TYPE_STYLES[type];
  return (
    <span
      className={`inline-flex h-[18px] items-center rounded-chip border bg-neutral-surface px-1.5 text-xs
        font-medium uppercase leading-none tracking-wide ${tone} ${className}`}
    >
      {label}
    </span>
  );
}
