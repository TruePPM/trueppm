/**
 * One backlog row. Click (or Enter/Space) selects the item into the right
 * pane; the Pull button is a nested, stop-propagated target. PULLED rows show
 * the destination project (when known) and a relative "pulled" timestamp.
 * Selection is a constant-width left border so selecting never shifts the grid.
 *
 * Drag-to-reorder is native HTML5 DnD, enabled only for PROPOSED rows when the
 * viewer can edit; the grip replaces the rank number on hover.
 */

import type { DragEvent, KeyboardEvent } from 'react';
import { formatRelative } from '@/lib/formatRelative';
import { ArrowRightIcon, DragHandleIcon } from '@/components/Icons';
import type { BacklogItem } from '../types';
import { HighlightedTitle } from './HighlightedTitle';
import { ItemTypeBadge } from './ItemTypeBadge';
import { StatusChip } from './StatusChip';
import { FOCUS_RING, LIST_GRID } from './styles';

interface BacklogListRowProps {
  item: BacklogItem;
  selected: boolean;
  dim: boolean;
  query: string;
  canEdit: boolean;
  /** In-flight pull — dashed pulse border. */
  pending: boolean;
  draggable: boolean;
  isDropTarget: boolean;
  onSelect: () => void;
  onPull: () => void;
  onDragStart?: () => void;
  onDragEnter?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}

const MAX_INLINE_TAGS = 2;

export function BacklogListRow({
  item,
  selected,
  dim,
  query,
  canEdit,
  pending,
  draggable,
  isDropTarget,
  onSelect,
  onPull,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: BacklogListRowProps) {
  const visibleTags = item.tags.slice(0, MAX_INLINE_TAGS);
  const overflowTags = item.tags.length - visibleTags.length;

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={item.title}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={(e: DragEvent) => draggable && e.preventDefault()}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group grid ${LIST_GRID} h-11 cursor-pointer items-center gap-2 border-b border-l-2
        border-neutral-border/60 px-3.5 text-[13px] ${FOCUS_RING}
        ${selected ? 'border-l-brand-primary bg-brand-primary-light' : 'border-l-transparent hover:bg-chrome-row-hover'}
        ${dim ? 'opacity-45' : ''}
        ${pending ? 'animate-pulse outline-dashed outline-1 outline-brand-primary' : ''}
        ${isDropTarget ? 'border-t-2 border-t-brand-primary' : ''}`}
    >
      {/* Rank / drag grip */}
      <span className="relative flex justify-center">
        <span
          className={`tppm-mono text-[11px] tabular-nums text-neutral-text-disabled ${draggable ? 'group-hover:opacity-0' : ''}`}
        >
          {item.priorityRank}
        </span>
        {draggable && (
          <DragHandleIcon
            aria-hidden="true"
            className="absolute h-3.5 w-3.5 cursor-grab text-neutral-text-secondary opacity-0 group-hover:opacity-100"
          />
        )}
      </span>

      {/* Type */}
      <span>
        <ItemTypeBadge type={item.itemType} />
      </span>

      {/* Title + inline tags */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate text-neutral-text-primary ${selected ? 'font-semibold' : ''}`}>
          <HighlightedTitle title={item.title} query={query} />
        </span>
        {visibleTags.map((tag) => (
          <span
            key={tag}
            className="hidden shrink-0 rounded bg-neutral-surface-sunken px-1.5 py-px text-xs text-neutral-text-secondary lg:inline"
          >
            {tag}
          </span>
        ))}
        {overflowTags > 0 && (
          <span className="hidden shrink-0 text-xs text-neutral-text-disabled lg:inline">
            +{overflowTags}
          </span>
        )}
      </span>

      {/* Status (or destination project for PULLED) */}
      <span className="min-w-0">
        {item.status === 'PULLED' && item.pulledTo?.projectName ? (
          <span
            className="flex min-w-0 items-center gap-1.5"
            title={`Pulled to ${item.pulledTo.projectName}`}
          >
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-brand-primary" />
            <span className="truncate text-xs text-neutral-text-secondary">
              {item.pulledTo.projectName}
            </span>
          </span>
        ) : (
          <StatusChip status={item.status} />
        )}
      </span>

      {/* Action */}
      <span className="flex justify-end">
        {item.status === 'PROPOSED' && canEdit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPull();
            }}
            aria-label={`Pull ${item.title} to a project`}
            className={`inline-flex h-6 items-center gap-1 rounded border border-neutral-border bg-neutral-surface
              px-2 text-[11px] font-medium text-neutral-text-primary hover:border-brand-primary ${FOCUS_RING}`}
          >
            Pull
            <ArrowRightIcon aria-hidden="true" className="h-3 w-3" />
          </button>
        )}
        {item.status === 'PULLED' && item.pulledTo && (
          <span className="tppm-mono text-xs text-neutral-text-secondary">
            {formatRelative(new Date(item.pulledTo.at))}
          </span>
        )}
      </span>
    </div>
  );
}
