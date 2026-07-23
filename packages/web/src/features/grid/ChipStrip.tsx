import type { TaskStatus } from '@/types';
import { STATUS_LABEL } from './ui';

export interface ActiveFilter {
  key: 'owner' | 'status' | 'search' | 'overdue';
  label: string;
  value: string;
}

interface ChipStripProps {
  search: string;
  ownerFilter: string;
  statusFilter: TaskStatus | '';
  overdue: boolean;
  onRemove: (key: ActiveFilter['key']) => void;
}

/**
 * Active-filter chip strip rendered as Row 2 of the Grid toolbar — only
 * present when at least one filter is set, so the empty case costs zero
 * vertical space.
 */
export function ChipStrip({
  search,
  ownerFilter,
  statusFilter,
  overdue,
  onRemove,
}: ChipStripProps) {
  const chips: ActiveFilter[] = [
    ...(search ? [{ key: 'search' as const, label: `"${search}"`, value: search }] : []),
    ...(ownerFilter
      ? [{ key: 'owner' as const, label: `Owner: ${ownerFilter}`, value: ownerFilter }]
      : []),
    ...(statusFilter
      ? [
          {
            key: 'status' as const,
            label: `Status: ${STATUS_LABEL[statusFilter] ?? statusFilter}`,
            value: statusFilter,
          },
        ]
      : []),
    ...(overdue ? [{ key: 'overdue' as const, label: 'Overdue', value: 'overdue' }] : []),
  ];
  if (chips.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-border
        bg-neutral-surface-raised flex-shrink-0 flex-wrap"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border
            border-brand-primary/40 bg-brand-primary/10 text-xs text-brand-primary"
        >
          {chip.label}
          {/* Chip remove button: focus: (not focus-visible:) so the ring shows on
              pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7). */}
          <button
            type="button"
            onClick={() => onRemove(chip.key)}
            aria-label={`Remove ${chip.label} filter`}
            className="ml-0.5 hover:text-brand-primary-dark
              focus:outline-none focus:ring-1 focus:ring-brand-primary rounded-full"
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}
