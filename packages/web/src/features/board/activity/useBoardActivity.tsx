/**
 * Data hook + display metadata for the board activity feed panel (ADR-0160, issue 1261).
 *
 * Consumes the shipped read API (issue 325): a board-scoped, time-ordered feed of card
 * mutations with keyset pagination (`until` → `next_until`). Filtering is server-side;
 * the panel maps its chip state onto the `type` / `actor` / `since` params.
 */

import type { ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { PencilIcon } from '@/components/Icons';

export type BoardEventType =
  | 'task_created'
  | 'task_updated'
  | 'task_deleted'
  | 'entered_sprint'
  | 'exited_sprint'
  | 'moved_sprint'
  | 'comment_added';

export interface BoardActivityChange {
  field: string;
  old: string | null;
  new: string | null;
}

export interface BoardActivityEvent {
  id: string;
  event_type: BoardEventType;
  /** Display name of the actor, or null for a system/automated change. */
  actor: string | null;
  actor_id: string | null;
  timestamp: string;
  task_id: string;
  task_name: string;
  sprint_id: string | null;
  changes: BoardActivityChange[];
}

interface BoardActivityResponse {
  results: BoardActivityEvent[];
  next_until: string | null;
}

/** Per-event-type glyph, semantic tint, and verb phrase. Color is never the only cue —
 *  the verb carries the meaning and the icon is aria-hidden (rule 6). */
export const EVENT_META: Record<BoardEventType, { icon: ReactNode; tint: string; verb: string }> = {
  task_created: { icon: '＋', tint: 'text-semantic-on-track', verb: 'created' },
  task_updated: {
    icon: <PencilIcon className="h-4 w-4" aria-hidden="true" />,
    tint: 'text-neutral-text-secondary',
    verb: 'updated',
  },
  task_deleted: { icon: '✕', tint: 'text-semantic-critical', verb: 'deleted' },
  entered_sprint: { icon: '→', tint: 'text-brand-primary', verb: 'added to sprint' },
  exited_sprint: { icon: '←', tint: 'text-brand-primary', verb: 'removed from sprint' },
  moved_sprint: { icon: '⇄', tint: 'text-brand-primary', verb: 'moved sprint' },
  comment_added: { icon: '💬', tint: 'text-neutral-text-secondary', verb: 'commented' },
};

/** Coarse type groups the chip bar exposes, mapped to the server `type` comma list. */
export type TypeGroup = 'all' | 'cards' | 'sprint' | 'comments';
export type TimeRange = 'any' | '24h' | '7d' | '30d';
/** Whether the feed is narrowed to the current sprint or shows the whole board
 *  (ADR-0412, #1946). Only meaningful when the host supplies an active sprint id. */
export type ActivityScope = 'sprint' | 'board';

export interface BoardActivityFilterState {
  typeGroup: TypeGroup;
  actorId: string | null;
  range: TimeRange;
  scope: ActivityScope;
}

export const DEFAULT_FILTERS: BoardActivityFilterState = {
  typeGroup: 'all',
  actorId: null,
  range: 'any',
  scope: 'board',
};

const TYPE_PARAM: Record<TypeGroup, string | undefined> = {
  all: undefined,
  cards: 'task_created,task_updated,task_deleted',
  sprint: 'entered_sprint,exited_sprint,moved_sprint',
  comments: 'comment_added',
};

const RANGE_MS: Record<TimeRange, number | undefined> = {
  any: undefined,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** ISO lower-bound for a relative range, or undefined for "any time". */
export function sinceFor(range: TimeRange, now: number = Date.now()): string | undefined {
  const ms = RANGE_MS[range];
  return ms === undefined ? undefined : new Date(now - ms).toISOString();
}

/** The sprint id actually sent to the server, or undefined for whole-board scope.
 *  Sprint scope only applies when the host supplied a sprint id AND the toggle is
 *  on "This sprint" (ADR-0412, #1946). */
export function effectiveSprintId(
  scope: ActivityScope,
  sprintId: string | null | undefined,
): string | undefined {
  return scope === 'sprint' && sprintId ? sprintId : undefined;
}

export function useBoardActivity(
  projectId: string | undefined,
  filters: BoardActivityFilterState,
  sprintId?: string | null,
) {
  const sprintScope = effectiveSprintId(filters.scope, sprintId);
  return useInfiniteQuery({
    queryKey: [
      'board-activity',
      projectId,
      filters.typeGroup,
      filters.actorId,
      filters.range,
      sprintScope ?? null,
    ],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { limit: '50' };
      if (pageParam) params.until = pageParam;
      const type = TYPE_PARAM[filters.typeGroup];
      if (type) params.type = type;
      if (filters.actorId) params.actor = filters.actorId;
      const since = sinceFor(filters.range);
      if (since) params.since = since;
      if (sprintScope) params.sprint = sprintScope;
      const res = await apiClient.get<BoardActivityResponse>(
        `/projects/${projectId}/board/activity`,
        { params },
      );
      return res.data;
    },
    // The cursor is the previous page's `next_until` (an ISO datetime), null when exhausted.
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_until ?? undefined,
    enabled: !!projectId,
    refetchOnWindowFocus: true,
    staleTime: 15 * 1000,
  });
}
