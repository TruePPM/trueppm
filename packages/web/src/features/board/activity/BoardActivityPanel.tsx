/**
 * Board activity feed panel (ADR-0160, issue 1261) — the web surface for the shipped
 * read API (issue 325). A board-scoped, filterable, time-ordered audit of card
 * mutations, rendered as a collapsible right rail (overlay on mobile).
 *
 * This slice is read + filter + click-through only; the live `board.activity` WebSocket
 * push and the perf composite index are a tracked follow-up (issue 1261 deferred items).
 * Until then the feed refetches on window focus and via the header refresh control.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BoardActivityRow } from './BoardActivityRow';
import { BoardActivityFilters, type ActorOption } from './BoardActivityFilters';
import {
  DEFAULT_FILTERS,
  useBoardActivity,
  type BoardActivityEvent,
  type BoardActivityFilterState,
} from './useBoardActivity';

interface BoardActivityPanelProps {
  projectId: string;
  onClose: () => void;
  /** Open the related card's detail drawer (resolved by the host from its loaded set). */
  onOpenTask: (taskId: string) => void;
  /** Whether a task is still on the board (loaded) — a deleted/absent card isn't openable. */
  isTaskOpenable: (taskId: string) => boolean;
}

export function BoardActivityPanel({
  projectId,
  onClose,
  onOpenTask,
  isTaskOpenable,
}: BoardActivityPanelProps) {
  const [filters, setFilters] = useState<BoardActivityFilterState>(DEFAULT_FILTERS);
  const {
    data,
    isLoading,
    isError,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useBoardActivity(projectId, filters);

  const events: BoardActivityEvent[] = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.results),
    [data],
  );

  // Distinct actors seen so far populate the person filter (no separate roster fetch).
  const actors: ActorOption[] = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.actor_id && e.actor) m.set(e.actor_id, e.actor);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [events]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 6,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Infinite scroll: when the last virtual row is reached, pull the next keyset page.
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (last && last.index >= events.length - 1 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [virtualItems, events.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <aside
      aria-label="Board activity"
      className="flex h-full w-full flex-col bg-neutral-surface motion-safe:animate-save-bar-slide"
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-border px-3 py-2">
        <h2 className="text-sm font-semibold text-neutral-text-primary">Activity</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh activity"
            title="Refresh"
            className="rounded p-1 text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span aria-hidden="true" className={isRefetching ? 'inline-block animate-spin' : ''}>
              ⟳
            </span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close activity panel"
            className="rounded p-1 text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <BoardActivityFilters filters={filters} actors={actors} onChange={setFilters} />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && (
          <div className="space-y-px p-3" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-14 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div role="alert" className="p-4 text-xs text-semantic-critical">
            Couldn&apos;t load activity.{' '}
            <button
              type="button"
              onClick={() => void refetch()}
              className="font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Retry
            </button>
          </div>
        )}

        {!isLoading && !isError && events.length === 0 && (
          <p className="p-4 text-xs text-neutral-text-secondary">
            {filters.typeGroup !== 'all' || filters.actorId || filters.range !== 'any'
              ? 'No activity matches these filters.'
              : 'No board activity yet.'}
          </p>
        )}

        {!isLoading && !isError && events.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualItems.map((vi) => {
              const event = events[vi.index];
              const openable = event.event_type !== 'task_deleted' && isTaskOpenable(event.task_id);
              return (
                <div
                  key={event.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                  className="border-b border-neutral-border"
                >
                  <BoardActivityRow
                    event={event}
                    onOpen={openable ? () => onOpenTask(event.task_id) : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}

        {isFetchingNextPage && (
          <p className="px-3 py-2 text-xs text-neutral-text-secondary">Loading older…</p>
        )}
      </div>
    </aside>
  );
}
