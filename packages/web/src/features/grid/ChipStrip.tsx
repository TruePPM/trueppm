import { useRef } from 'react';
import type { RefObject } from 'react';
import { XMarkIcon } from '@/components/Icons';
import { LabelChip } from '@/components/filters/LabelChip';
import type { TaskStatus } from '@/types';
import { STATUS_LABEL } from './ui';

export interface ActiveFilter {
  key: 'owner' | 'status' | 'search' | 'overdue';
  label: string;
  value: string;
}

/** One active label chip: the catalog entry plus its match count in this view. */
export interface ActiveLabelChip {
  id: string;
  name: string;
  color: string;
  count: number;
}

interface ChipStripProps {
  search: string;
  ownerFilter: string;
  statusFilter: TaskStatus | '';
  overdue: boolean;
  /** Active label filters, in selection order. */
  labelChips?: ActiveLabelChip[];
  onRemove: (key: ActiveFilter['key']) => void;
  onRemoveLabel?: (id: string) => void;
  /** Focused when the last label chip is removed, so focus never lands on `body`. */
  labelTriggerRef?: RefObject<HTMLButtonElement | null>;
  /** Rendered before the chips — carries the offline note ("filtering N loaded rows"). */
  note?: string;
}

/**
 * Active-filter chip strip rendered as Row 2 of the Grid toolbar — only
 * present when at least one filter is set, so the empty case costs zero
 * vertical space.
 *
 * Label chips are removable individually (each carries its own ✕) rather than
 * collapsing into one "Label: 2" chip, because the user's next action after an
 * over-narrow result is almost always to drop *one* of them.
 */
export function ChipStrip({
  search,
  ownerFilter,
  statusFilter,
  overdue,
  labelChips = [],
  onRemove,
  onRemoveLabel,
  labelTriggerRef,
  note,
}: ChipStripProps) {
  // Chip ✕ buttons indexed in render order, so removing chip i can hand focus to
  // whatever is about to occupy slot i — the next chip, or the facet trigger when
  // the strip empties. Without this, focus falls to `body` and a keyboard user
  // loses their place mid-refinement.
  const removeRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
  if (chips.length === 0 && labelChips.length === 0) return null;

  function handleRemoveLabel(id: string, index: number) {
    onRemoveLabel?.(id);
    const next = removeRefs.current[index + 1];
    if (next) next.focus();
    else labelTriggerRef?.current?.focus();
  }

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-border
        bg-neutral-surface-raised flex-shrink-0 flex-wrap"
    >
      {note && <span className="text-xs text-neutral-text-secondary">{note}</span>}
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border
            border-brand-primary/40 bg-brand-primary/10 text-xs text-brand-primary"
        >
          {chip.label}
          {/* Chip remove button: focus: (not focus-visible:) so the ring shows on
              pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7).
              House SVG, not a `✕` codepoint (rule 242) — the label chips beside
              these render `XMarkIcon`, and a Unicode glyph next to an SVG in the
              same row is visibly a different weight and baseline. */}
          <button
            type="button"
            onClick={() => onRemove(chip.key)}
            aria-label={`Remove ${chip.label} filter`}
            className="ml-0.5 hover:text-brand-primary-dark
              focus:outline-none focus:ring-1 focus:ring-brand-primary rounded-full"
          >
            <XMarkIcon aria-hidden="true" className="h-3 w-3" />
          </button>
        </span>
      ))}
      {labelChips.map((chip, index) => (
        <LabelChip
          key={chip.id}
          name={chip.name}
          color={chip.color}
          count={chip.count}
          removeRef={(el) => {
            removeRefs.current[index] = el;
          }}
          onRemove={() => handleRemoveLabel(chip.id, index)}
        />
      ))}
    </div>
  );
}
