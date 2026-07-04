/**
 * Pure URL <-> filter-state mapping and click-through routing for the project
 * Activity tab (ADR-0201, #371). Kept separate from the component so the
 * deep-link round-trip and the per-object-type navigation are unit-testable.
 *
 * The URL search params ARE the filter source of truth, so the current view is
 * always deep-linkable — a PM can paste "the changes since last Tuesday" into
 * Slack and the recipient lands on the same filtered feed.
 */

import type {
  ChangelogEntry,
  ChangelogFilterState,
  ChangelogObjectType,
  ChangeType,
  TimeRange,
} from './useProjectChangelog';

const OBJECT_TYPES: readonly ChangelogObjectType[] = [
  'task',
  'sprint',
  'risk',
  'dependency',
  'project',
  'task_recurrence',
  'guardrail_policy',
  'signal_privacy_policy',
  'decisions_policy',
];
const CHANGE_TYPES: readonly ChangeType[] = ['created', 'updated', 'deleted'];
const RANGES: readonly TimeRange[] = ['any', '24h', '7d', '30d'];

const OBJECT_TYPE_SET = new Set<string>(OBJECT_TYPES);
const CHANGE_TYPE_SET = new Set<string>(CHANGE_TYPES);
const RANGE_SET = new Set<string>(RANGES);

/** Serialize filter state into URL search params (omits defaults for clean links). */
export function filtersToSearchParams(filters: ChangelogFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.objectTypes.size > 0) {
    params.set('type', [...filters.objectTypes].sort().join(','));
  }
  if (filters.changeTypes.size > 0) {
    params.set('change', [...filters.changeTypes].sort().join(','));
  }
  if (filters.userId) params.set('user', filters.userId);
  if (filters.range !== 'any') params.set('range', filters.range);
  return params;
}

/** Parse URL search params back into filter state, dropping any unknown token. */
export function searchParamsToFilters(params: URLSearchParams): ChangelogFilterState {
  const objectTypes = new Set<ChangelogObjectType>();
  for (const t of (params.get('type') ?? '').split(',')) {
    if (OBJECT_TYPE_SET.has(t)) objectTypes.add(t as ChangelogObjectType);
  }
  const changeTypes = new Set<ChangeType>();
  for (const c of (params.get('change') ?? '').split(',')) {
    if (CHANGE_TYPE_SET.has(c)) changeTypes.add(c as ChangeType);
  }
  const rawRange = params.get('range') ?? 'any';
  const range: TimeRange = RANGE_SET.has(rawRange) ? (rawRange as TimeRange) : 'any';
  return {
    objectTypes,
    changeTypes,
    userId: params.get('user') || null,
    range,
  };
}

/**
 * The in-app path a changelog row's affected object navigates to. Types with a
 * dedicated detail surface (task) deep-link to it; the rest land on the closest
 * view that renders the object (its list/settings page).
 */
export function clickThroughPath(projectId: string, entry: ChangelogEntry): string {
  const base = `/projects/${projectId}`;
  switch (entry.object_type) {
    case 'task':
      return `${base}/tasks/${entry.object_id}`;
    case 'risk':
      return `${base}/risk`;
    case 'sprint':
      return `${base}/sprints`;
    case 'dependency':
    case 'task_recurrence':
      return `${base}/schedule`;
    case 'project':
    case 'guardrail_policy':
    case 'signal_privacy_policy':
    case 'decisions_policy':
      return `${base}/settings`;
    default:
      return base;
  }
}
