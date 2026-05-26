/**
 * The list pane: column header, the main (filtered) rows with drag-to-reorder,
 * and the collapsible Pulled section. Falls back to <NoResults> when filters
 * empty the view. Owns only transient drag state; everything else comes from
 * the controller.
 *
 * Reorder is native HTML5 DnD over PROPOSED rows: dropping onto a row hands its
 * priorityRank to the dragged item, and the mutation re-stripes ranks.
 */

import { useState } from 'react';
import { matchesSearch } from '../filter';
import type { BacklogController } from '../hooks/useBacklogController';
import type { BacklogItem } from '../types';
import { BacklogListHeader } from './BacklogListHeader';
import { BacklogListRow } from './BacklogListRow';
import { NoResults } from './NoResults';
import { PulledSectionHeader } from './PulledSectionHeader';

interface BacklogListProps {
  controller: BacklogController;
}

export function BacklogList({ controller }: BacklogListProps) {
  const { url, mainItems, pulledItems, canEdit, pendingPullItemId, searchActive, matchCount } =
    controller;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Facets emptied the list, or search matched nothing → recovery state.
  const facetsEmpty = mainItems.length === 0 && pulledItems.length === 0;
  const searchMiss = searchActive && matchCount === 0;
  const showNoResults = facetsEmpty || searchMiss;
  const hasActiveFacets = url.types.length > 0 || url.tags.length > 0;

  function commitDrop(target: BacklogItem) {
    if (draggingId && draggingId !== target.id) {
      void controller.reorderItem(draggingId, target.priorityRank);
    }
    setDraggingId(null);
    setDropTargetId(null);
  }

  function renderRow(item: BacklogItem) {
    const isProposed = item.status === 'PROPOSED';
    const draggable = canEdit && isProposed;
    return (
      <BacklogListRow
        key={item.id}
        item={item}
        selected={url.selectedItemId === item.id}
        dim={searchActive && !matchesSearch(item, url.query)}
        query={url.query}
        canEdit={canEdit}
        pending={pendingPullItemId === item.id}
        draggable={draggable}
        isDropTarget={dropTargetId === item.id && draggingId !== item.id}
        onSelect={() => url.selectItem(item.id)}
        onPull={() => url.openPull(item.id)}
        onDragStart={draggable ? () => setDraggingId(item.id) : undefined}
        onDragEnter={draggable ? () => setDropTargetId(item.id) : undefined}
        onDrop={draggable ? () => commitDrop(item) : undefined}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTargetId(null);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <BacklogListHeader />
      {showNoResults ? (
        <NoResults
          query={url.query}
          totalCount={controller.counts.all}
          hasActiveFacets={hasActiveFacets}
          onClearSearch={url.clearSearch}
          onResetFilters={url.resetFilters}
        />
      ) : (
        <>
          <div>{mainItems.map(renderRow)}</div>
          {pulledItems.length > 0 && (
            <div>
              <PulledSectionHeader
                count={pulledItems.length}
                open={url.pulledOpen}
                onToggle={() => url.setPulledOpen(!url.pulledOpen)}
              />
              {url.pulledOpen && <div>{pulledItems.map(renderRow)}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
