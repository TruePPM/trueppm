import { type RefObject } from 'react';

export interface CardPopoverFooterProps {
  onOpenDetail: () => void;
  onEdit: () => void;
  /** Receives focus on popover open. */
  openDetailRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Footer with two actions: Open detail (primary path on focus open) and
 * Edit (brand-primary fill). Variation B's Move picker is deferred per the
 * #304 ux-design spec — keeps the audit-trail concern out of scope.
 */
export function CardPopoverFooter({ onOpenDetail, onEdit, openDetailRef }: CardPopoverFooterProps) {
  return (
    <div className="flex gap-2 px-4 py-2.5 border-t border-neutral-border bg-neutral-surface-raised">
      <button
        ref={openDetailRef}
        type="button"
        onClick={onOpenDetail}
        className="flex-1 h-8 md:h-8 min-h-11 md:min-h-0 rounded-control border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        Open detail
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="h-8 md:h-8 min-h-11 md:min-h-0 px-3.5 rounded-control bg-brand-primary text-white text-[13px] font-medium border-none hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
      >
        Edit
      </button>
    </div>
  );
}
