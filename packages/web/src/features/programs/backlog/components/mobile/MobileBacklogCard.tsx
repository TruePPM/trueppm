/**
 * Mobile list item — a card, not a squeezed desktop row (06-mobile). Tapping
 * the card opens the detail drawer; the Pull button is a separate, stop-
 * propagated touch target. The Pull button is bumped to a 36px tap target
 * (the design's 28px is below the 44px guidance; height + padding compensate).
 */

import { formatRelative } from '@/lib/formatRelative';
import { ArrowRightIcon } from '@/components/Icons';
import type { BacklogItem, BacklogMember } from '../../types';
import { Avatar } from '../Avatar';
import { HighlightedTitle } from '../HighlightedTitle';
import { ItemTypeBadge } from '../ItemTypeBadge';
import { FOCUS_RING } from '../styles';

interface MobileBacklogCardProps {
  item: BacklogItem;
  owner?: BacklogMember;
  query: string;
  canEdit: boolean;
  onSelect: () => void;
  onPull: () => void;
}

export function MobileBacklogCard({
  item,
  owner,
  query,
  canEdit,
  onSelect,
  onPull,
}: MobileBacklogCardProps) {
  const tags = item.tags.slice(0, 2);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${item.id}: ${item.title}`}
      className={`flex w-full flex-col gap-1.5 rounded-lg border border-neutral-border bg-neutral-surface px-3.5 py-3 text-left ${FOCUS_RING}`}
    >
      <div className="flex items-center gap-2">
        <span className="tppm-mono flex-1 text-[10px] text-neutral-text-disabled">
          #{item.priorityRank} · {item.id}
        </span>
        <ItemTypeBadge type={item.itemType} />
      </div>

      <div className="line-clamp-2 text-sm font-medium leading-snug text-neutral-text-primary">
        <HighlightedTitle title={item.title} query={query} />
      </div>

      <div className="flex items-center gap-2">
        {owner && <Avatar initials={owner.initials} name={owner.name} size={20} />}
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-neutral-surface-sunken px-1.5 py-0.5 text-[10px] text-neutral-text-secondary"
            >
              {tag}
            </span>
          ))}
        </div>
        {item.status === 'PROPOSED' && canEdit && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onPull();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                onPull();
              }
            }}
            aria-label={`Pull ${item.title} to a project`}
            className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-md bg-brand-primary px-3 text-xs font-medium text-white ${FOCUS_RING}`}
          >
            Pull
            <ArrowRightIcon aria-hidden="true" className="h-3 w-3" />
          </span>
        )}
        {item.status === 'PULLED' && item.pulledTo && (
          <span className="tppm-mono shrink-0 text-[10px] text-neutral-text-secondary">
            {item.pulledTo.projectName} · {formatRelative(new Date(item.pulledTo.at))}
          </span>
        )}
      </div>
    </button>
  );
}
