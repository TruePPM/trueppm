/**
 * Data hook + display metadata for the unified project changelog (ADR-0201, issue 371).
 *
 * Consumes GET /projects/{id}/changelog/ — a project-wide, newest-first "what
 * changed" stream aggregated across every project-scoped historical table, with a
 * stable opaque keyset cursor (`next_cursor`). Filtering is server-side; the
 * Activity tab maps its chip state onto the `object_type` / `change_type` /
 * `since` / `user` params. The cursor is opaque — the client only echoes it back.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Source object types the endpoint aggregates (mirrors changelog.object_type_choices). */
export type ChangelogObjectType =
  | 'task'
  | 'sprint'
  | 'risk'
  | 'dependency'
  | 'project'
  | 'task_recurrence'
  | 'guardrail_policy'
  | 'signal_privacy_policy'
  | 'decisions_policy';

export type ChangeType = 'created' | 'updated' | 'deleted';

export interface ChangelogChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface ChangelogUser {
  id: string;
  display_name: string;
}

export interface ChangelogEntry {
  id: string;
  object_type: ChangelogObjectType;
  object_id: string;
  object_label: string;
  change_type: ChangeType;
  history_date: string;
  /** Actor, or null (system change, or the caller cannot see users — below Admin). */
  user: ChangelogUser | null;
  changes: ChangelogChange[];
}

interface ChangelogResponse {
  results: ChangelogEntry[];
  next_cursor: string | null;
}

/** Per-object-type label + glyph. Color is never the only cue — the label carries
 *  the meaning and the glyph is aria-hidden (web-rule 6). */
export const OBJECT_TYPE_META: Record<ChangelogObjectType, { label: string; icon: string }> = {
  task: { label: 'Task', icon: '□' },
  sprint: { label: 'Sprint', icon: '◇' },
  risk: { label: 'Risk', icon: '△' },
  dependency: { label: 'Dependency', icon: '⇢' },
  project: { label: 'Project', icon: '◈' },
  task_recurrence: { label: 'Recurrence', icon: '↻' },
  guardrail_policy: { label: 'Guardrail policy', icon: '⚑' },
  signal_privacy_policy: { label: 'Privacy policy', icon: '🔒' },
  decisions_policy: { label: 'Decisions policy', icon: '⚖' },
};

/** Per-change-type verb + semantic tint. The verb is the WCAG 1.4.1 non-color cue. */
export const CHANGE_TYPE_META: Record<ChangeType, { verb: string; tint: string }> = {
  created: { verb: 'created', tint: 'text-semantic-on-track' },
  updated: { verb: 'updated', tint: 'text-neutral-text-secondary' },
  deleted: { verb: 'deleted', tint: 'text-semantic-critical' },
};

export type TimeRange = 'any' | '24h' | '7d' | '30d';

export interface ChangelogFilterState {
  /** Empty set = all object types. */
  objectTypes: Set<ChangelogObjectType>;
  /** Empty set = all change types. */
  changeTypes: Set<ChangeType>;
  userId: string | null;
  range: TimeRange;
}

export const DEFAULT_CHANGELOG_FILTERS: ChangelogFilterState = {
  objectTypes: new Set(),
  changeTypes: new Set(),
  userId: null,
  range: 'any',
};

const RANGE_MS: Record<TimeRange, number | undefined> = {
  any: undefined,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** ISO lower-bound for a relative range, or undefined for "any time". */
export function sinceForRange(range: TimeRange, now: number = Date.now()): string | undefined {
  const ms = RANGE_MS[range];
  return ms === undefined ? undefined : new Date(now - ms).toISOString();
}

/** Build the server query params from the current filter state (pure — unit-tested). */
export function changelogParams(filters: ChangelogFilterState): Record<string, string> {
  const params: Record<string, string> = { page_size: '50' };
  if (filters.objectTypes.size > 0) params.object_type = [...filters.objectTypes].sort().join(',');
  if (filters.changeTypes.size > 0) params.change_type = [...filters.changeTypes].sort().join(',');
  if (filters.userId) params.user = filters.userId;
  const since = sinceForRange(filters.range);
  if (since) params.since = since;
  return params;
}

export function useProjectChangelog(
  projectId: string | undefined,
  filters: ChangelogFilterState,
) {
  return useInfiniteQuery({
    queryKey: [
      'project-changelog',
      projectId,
      [...filters.objectTypes].sort().join(','),
      [...filters.changeTypes].sort().join(','),
      filters.userId,
      filters.range,
    ],
    queryFn: async ({ pageParam }) => {
      const params = changelogParams(filters);
      if (pageParam) params.cursor = pageParam;
      const res = await apiClient.get<ChangelogResponse>(
        `/projects/${projectId}/changelog/`,
        { params },
      );
      return res.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!projectId,
    refetchOnWindowFocus: true,
    staleTime: 15 * 1000,
  });
}
