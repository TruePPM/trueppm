/**
 * The list pane: column header, the main (filtered) rows with drag-to-reorder,
 * and the collapsible Pulled section. Falls back to <NoResults> when filters
 * empty the view. Owns only transient drag state; everything else comes from
 * the controller.
 *
 * Reorder is native HTML5 DnD over PROPOSED rows: dropping onto a row hands its
 * priorityRank to the dragged item, and the mutation re-stripes ranks. Because
 * DnD is not keyboard-operable (WCAG 2.1.1), each draggable row also accepts
 * Alt+ArrowUp / Alt+ArrowDown to swap with its neighbor, and a polite aria-live
 * region announces the move (web-rule 105 parallel / #1996).
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
  const [reorderMsg, setReorderMsg] = useState('');

  // Keyboard reorder (WCAG 2.1.1): swap the item with its neighbor in the ordered
  // main list by handing it the neighbor's priorityRank (the same operation the
  // drop path performs), then announce the move. A boundary move is a no-op.
  function moveBy(item: BacklogItem, delta: -1 | 1) {
    const index = mainItems.findIndex((i) => i.id === item.id);
    const neighbor = mainItems[index + delta];
    if (!neighbor) return;
    void controller.reorderItem(item.id, neighbor.priorityRank);
    setReorderMsg(`${item.title} moved ${delta === -1 ? 'up' : 'down'} to position ${index + delta + 1}.`);
  }

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
        onMoveUp={draggable ? () => moveBy(item, -1) : undefined}
        onMoveDown={draggable ? () => moveBy(item, 1) : undefined}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div aria-live="polite" role="status" className="sr-only">
        {reorderMsg}
      </div>
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
