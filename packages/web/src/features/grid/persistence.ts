/**
 * localStorage I/O for Grid view mode + group-by selection.
 *
 * Per ADR-0053, mode and group-by are persisted per-project under the
 * `trueppm.grid.<setting>.<projectId>.v1` key convention. A corrupt or
 * out-of-union value falls through to undefined so callers can apply the
 * methodology default.
 */

export type GridMode = 'flat' | 'outline' | 'grouped';
export type GridGroupBy = 'phase' | 'owner' | 'status' | 'sprint' | 'resource';

const MODE_VALUES: ReadonlySet<string> = new Set(['flat', 'outline', 'grouped']);
const GROUP_BY_VALUES: ReadonlySet<string> = new Set([
  'phase', 'owner', 'status', 'sprint', 'resource',
]);

function modeKey(projectId: string): string {
  return `trueppm.grid.mode.${projectId}.v1`;
}
function groupByKey(projectId: string): string {
  return `trueppm.grid.groupBy.${projectId}.v1`;
}

export function loadMode(projectId: string): GridMode | undefined {
  try {
    const raw = window.localStorage.getItem(modeKey(projectId));
    return raw && MODE_VALUES.has(raw) ? (raw as GridMode) : undefined;
  } catch {
    return undefined;
  }
}

export function saveMode(projectId: string, mode: GridMode): void {
  try {
    window.localStorage.setItem(modeKey(projectId), mode);
  } catch {
    // Storage unavailable / quota exceeded — silent fallback (in-session state still works).
  }
}

export function loadGroupBy(projectId: string): GridGroupBy | undefined {
  try {
    const raw = window.localStorage.getItem(groupByKey(projectId));
    return raw && GROUP_BY_VALUES.has(raw) ? (raw as GridGroupBy) : undefined;
  } catch {
    return undefined;
  }
}

export function saveGroupBy(projectId: string, groupBy: GridGroupBy): void {
  try {
    window.localStorage.setItem(groupByKey(projectId), groupBy);
  } catch {
    // ignore
  }
}
