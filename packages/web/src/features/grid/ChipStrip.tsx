import { useRef } from 'react';
import type { RefObject } from 'react';
import { XMarkIcon } from '@/components/Icons';
import { LabelChip } from '@/components/filters/LabelChip';

/** One active label chip: the catalog entry plus its match count in this view. */
export interface ActiveLabelChip {
  id: string;
  name: string;
  color: string;
  count: number;
}

/** One active owner or status chip. */
export interface ActiveValueChip {
  /** The value to remove — a resource id, or a `TaskStatus`. */
  id: string;
  /** Display name: the person's name, or the status label. */
  name: string;
}

interface ChipStripProps {
  search: string;
  /** Active owner filters, in selection order. */
  ownerChips?: ActiveValueChip[];
  /** Active status filters, in pipeline order. */
  statusChips?: ActiveValueChip[];
  /** Active label filters, in selection order. */
  labelChips?: ActiveLabelChip[];
  overdue: boolean;
  onRemoveSearch: () => void;
  onRemoveOwner?: (id: string) => void;
  onRemoveStatus?: (id: string) => void;
  onRemoveLabel?: (id: string) => void;
  onRemoveOverdue: () => void;
  /** Clears every facet at once and unmounts the strip. */
  onClearAll?: () => void;
  /** Focused when the last chip of that facet is removed, so focus never lands
   *  on `body`. One per facet trigger, in toolbar order. */
  ownerTriggerRef?: RefObject<HTMLButtonElement | null>;
  statusTriggerRef?: RefObject<HTMLButtonElement | null>;
  labelTriggerRef?: RefObject<HTMLButtonElement | null>;
  /** Rendered before the chips — carries the offline note ("filtering N loaded rows"). */
  note?: string;
}

/**
 * Active-filter chip strip rendered as Row 2 of the Grid toolbar — only present
 * when at least one filter is set, so the empty case costs zero vertical space.
 *
 * Chip order mirrors the toolbar exactly (search · Owner · Status · Label ·
 * Overdue) so the strip reads as a restatement of the controls above it rather
 * than a second, differently-ordered list of the same facts.
 *
 * Every value is its own removable chip rather than collapsing a facet into one
 * "Owner: 2" chip, because the user's next action after an over-narrow result is
 * almost always to drop *one* value.
 */
export function ChipStrip({
  search,
  ownerChips = [],
  statusChips = [],
  labelChips = [],
  overdue,
  onRemoveSearch,
  onRemoveOwner,
  onRemoveStatus,
  onRemoveLabel,
  onRemoveOverdue,
  onClearAll,
  ownerTriggerRef,
  statusTriggerRef,
  labelTriggerRef,
  note,
}: ChipStripProps) {
  // Chip ✕ buttons indexed in render order, so removing chip i can hand focus to
  // whatever is about to occupy slot i — the next chip, or the owning facet's
  // trigger when that facet empties. Without this, focus falls to `body` and a
  // keyboard user loses their place mid-refinement.
  const removeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const hasAny =
    Boolean(search) ||
    ownerChips.length > 0 ||
    statusChips.length > 0 ||
    labelChips.length > 0 ||
    overdue;
  if (!hasAny) return null;

  /**
   * Re-seat focus after a removal: the chip that slides into this slot, else the
   * trigger of the facet the chip belonged to.
   */
  function reseatFocus(index: number, fallback?: RefObject<HTMLButtonElement | null>) {
    const next = removeRefs.current[index + 1];
    if (next) next.focus();
    else fallback?.current?.focus();
  }

  // Render order = toolbar order. `cursor` walks the flattened chip sequence so
  // every chip — plain, label, or otherwise — shares one focus-handoff index.
  let cursor = -1;
  const nextIndex = () => {
    cursor += 1;
    return cursor;
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-border
        bg-neutral-surface-raised flex-shrink-0 flex-wrap"
    >
      {note && <span className="text-xs text-neutral-text-secondary">{note}</span>}

      {search && (
        <PlainChip
          index={nextIndex()}
          label={`"${search}"`}
          removeRefs={removeRefs}
          onRemove={(i) => {
            onRemoveSearch();
            reseatFocus(i);
          }}
        />
      )}

      {ownerChips.map((chip) => (
        <PlainChip
          key={`owner-${chip.id}`}
          index={nextIndex()}
          label={`Owner: ${chip.name}`}
          removeRefs={removeRefs}
          onRemove={(i) => {
            onRemoveOwner?.(chip.id);
            reseatFocus(i, ownerTriggerRef);
          }}
        />
      ))}

      {statusChips.map((chip) => (
        <PlainChip
          key={`status-${chip.id}`}
          index={nextIndex()}
          label={`Status: ${chip.name}`}
          removeRefs={removeRefs}
          onRemove={(i) => {
            onRemoveStatus?.(chip.id);
            reseatFocus(i, statusTriggerRef);
          }}
        />
      ))}

      {labelChips.map((chip) => {
        const index = nextIndex();
        return (
          <LabelChip
            key={`label-${chip.id}`}
            name={chip.name}
            color={chip.color}
            count={chip.count}
            removeRef={(el) => {
              removeRefs.current[index] = el;
            }}
            onRemove={() => {
              onRemoveLabel?.(chip.id);
              reseatFocus(index, labelTriggerRef);
            }}
          />
        );
      })}

      {overdue && (
        <PlainChip
          index={nextIndex()}
          label="Overdue"
          removeRefs={removeRefs}
          onRemove={(i) => {
            onRemoveOverdue();
            reseatFocus(i);
          }}
        />
      )}

      {onClearAll && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-semibold text-brand-primary underline
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            rounded-control"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

interface PlainChipProps {
  index: number;
  label: string;
  removeRefs: RefObject<(HTMLButtonElement | null)[]>;
  onRemove: (index: number) => void;
}

/**
 * A pill with a ✕. House SVG, not a `✕` codepoint (rule 242) — the label chips
 * beside these render `XMarkIcon`, and a Unicode glyph next to an SVG in the
 * same row is visibly a different weight and baseline.
 */
function PlainChip({ index, label, removeRefs, onRemove }: PlainChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1 h-6 px-2 rounded-full border
        border-brand-primary/40 bg-brand-primary/10 text-xs text-brand-primary"
    >
      {label}
      {/* focus: (not focus-visible:) so the ring shows on pointer-initiated
          focus in Firefox/Safari (rule 214, WCAG 2.4.7). */}
      <button
        ref={(el) => {
          removeRefs.current[index] = el;
        }}
        type="button"
        onClick={() => onRemove(index)}
        aria-label={`Remove ${label} filter`}
        className="ml-0.5 hover:text-brand-primary-dark
          focus:outline-none focus:ring-1 focus:ring-brand-primary rounded-full"
      >
        <XMarkIcon aria-hidden="true" className="h-3 w-3" />
      </button>
    </span>
  );
}
