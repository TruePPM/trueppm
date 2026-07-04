/**
 * Board filter facets (issue 1091) — pure, framework-free predicate layer.
 *
 * The board's cards are already loaded client-side, so faceting is a pure
 * derivation over the in-memory task list: no endpoint, no async. Everything a
 * facet needs to decide "does this card match?" lives in these functions so the
 * logic is unit-testable in isolation from React (ADR-0199).
 *
 * Composition rule: a task matches the active filter set when it matches EVERY
 * active facet group (AND across groups) and, within a group, ANY selected value
 * (OR within a group). An empty group imposes no constraint.
 *
 * Facets shipped: Assignee (multi + explicit Unassigned), Priority band (derived
 * from the integer `priorityRank`), Due window (Overdue / This week, derived from
 * `finish` and gated on `isTaskScheduled`). The Label facet is descoped — no
 * task-labels field exists yet (depends on issue 1089).
 */
import type { Task } from '@/types';
import { isTaskScheduled } from '@/lib/task';

/** Sentinel value in the assignee facet meaning "cards with no assignee". */
export const UNASSIGNED = '__unassigned__';

/**
 * Priority bands derived from the integer `priorityRank` (lower = higher
 * priority). There is no server-side band field, so these cutoffs are a client
 * convention — kept in one place so they are easy to rebind if a real band
 * lands. `unranked` covers a task with no `priorityRank` at all.
 */
export type PriorityBand = 'high' | 'medium' | 'low' | 'unranked';

/** Due windows, both derived from `finish` for scheduled tasks only. */
export type DueWindow = 'overdue' | 'this_week';

export interface FacetFilters {
  /** Resource ids, plus the {@link UNASSIGNED} sentinel for un-assigned cards. */
  assignees: string[];
  priority: PriorityBand[];
  due: DueWindow[];
}

export const EMPTY_FACETS: FacetFilters = { assignees: [], priority: [], due: [] };

const PRIORITY_BANDS: readonly PriorityBand[] = ['high', 'medium', 'low', 'unranked'];
const DUE_WINDOWS: readonly DueWindow[] = ['overdue', 'this_week'];

export const PRIORITY_BAND_LABEL: Record<PriorityBand, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unranked: 'Unranked',
};

export const DUE_WINDOW_LABEL: Record<DueWindow, string> = {
  overdue: 'Overdue',
  this_week: 'This week',
};

/**
 * Map an integer priority rank to a band. `undefined` (no rank assigned) → `unranked`.
 * Cutoffs: High = 1–3, Medium = 4–7, Low = 8+.
 */
export function priorityBandOf(rank: number | null | undefined): PriorityBand {
  if (rank == null) return 'unranked';
  if (rank <= 3) return 'high';
  if (rank <= 7) return 'medium';
  return 'low';
}

/**
 * Start-of-day in UTC. Task `finish` is a date-only ISO string (parsed as UTC
 * midnight), so anchoring the day boundary in UTC keeps the comparison
 * timezone-consistent — a card's due window never flips based on the viewer's
 * clock offset relative to the machine that stored the date.
 */
function startOfDayUtc(d: Date): number {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c.getTime();
}

/**
 * The due windows a task falls into, relative to `now`.
 *
 * Only *scheduled* tasks (a PM-committed `plannedStart`, or sprint membership —
 * see {@link isTaskScheduled}) are eligible. An uncommitted backlog card has an
 * `early_start`/`finish` auto-filled by CPM, but the PM has not committed to it,
 * so it must never surface under a due-window filter — this is the same
 * planned-vs-early-start rule the rest of the board honors, and the explicit
 * `plannedStart == null` + `start` set edge case in the tests.
 *
 * - `overdue`: finish is strictly before today.
 * - `this_week`: finish is today through the end of the current week (Sunday).
 */
export function dueWindowsOf(
  task: Pick<Task, 'plannedStart' | 'sprintId' | 'finish'>,
  now: Date,
): Set<DueWindow> {
  const out = new Set<DueWindow>();
  if (!isTaskScheduled(task)) return out;
  if (!task.finish) return out;
  const finish = new Date(task.finish).getTime();
  if (Number.isNaN(finish)) return out;

  const start = startOfDayUtc(now);
  if (finish < start) {
    out.add('overdue');
    return out;
  }
  const dow = new Date(start).getUTCDay(); // 0 = Sunday … 6 = Saturday
  const daysUntilSunday = (7 - dow) % 7;
  const endOfWeek = start + (daysUntilSunday + 1) * 86_400_000 - 1;
  if (finish <= endOfWeek) out.add('this_week');
  return out;
}

/** Total number of selected facet values across every group. Drives the badge. */
export function activeFacetCount(filters: FacetFilters): number {
  return filters.assignees.length + filters.priority.length + filters.due.length;
}

export function isFacetsActive(filters: FacetFilters): boolean {
  return activeFacetCount(filters) > 0;
}

/**
 * Does `task` match the active facet set? AND across active groups, OR within a
 * group. Summary tasks are never cards, so callers should exclude them before
 * calling; this predicate itself makes no such assumption.
 */
export function matchesFacets(task: Task, filters: FacetFilters, now: Date): boolean {
  if (filters.assignees.length > 0) {
    const wantsUnassigned = filters.assignees.includes(UNASSIGNED);
    const isUnassigned = task.assignees.length === 0;
    const hasSelectedAssignee = task.assignees.some((a) => filters.assignees.includes(a.resourceId));
    if (!((wantsUnassigned && isUnassigned) || hasSelectedAssignee)) return false;
  }

  if (filters.priority.length > 0) {
    if (!filters.priority.includes(priorityBandOf(task.priorityRank))) return false;
  }

  if (filters.due.length > 0) {
    const windows = dueWindowsOf(task, now);
    if (!filters.due.some((w) => windows.has(w))) return false;
  }

  return true;
}

/** Unique assignee options across a task list, sorted by display name. */
export function collectAssigneeOptions(tasks: Task[]): { resourceId: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const t of tasks) {
    for (const a of t.assignees) {
      if (!byId.has(a.resourceId)) byId.set(a.resourceId, a.name);
    }
  }
  return [...byId.entries()]
    .map(([resourceId, name]) => ({ resourceId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// URL param <-> FacetFilters (shareable links)
// ---------------------------------------------------------------------------
//
// Param keys: fa = assignees, fp = priority bands, fd = due windows. Each is a
// comma-joined list. Unknown/invalid tokens are dropped on parse so a stale or
// hand-edited link degrades gracefully rather than throwing.

const PARAM_ASSIGNEES = 'fa';
const PARAM_PRIORITY = 'fp';
const PARAM_DUE = 'fd';

function splitParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseFacetsFromParams(params: URLSearchParams): FacetFilters {
  const priority = splitParam(params.get(PARAM_PRIORITY)).filter((v): v is PriorityBand =>
    (PRIORITY_BANDS as readonly string[]).includes(v),
  );
  const due = splitParam(params.get(PARAM_DUE)).filter((v): v is DueWindow =>
    (DUE_WINDOWS as readonly string[]).includes(v),
  );
  // Assignee tokens are opaque resource ids (or the UNASSIGNED sentinel); keep
  // them all — validation against the live roster happens at render time.
  const assignees = splitParam(params.get(PARAM_ASSIGNEES));
  return { assignees, priority, due };
}

/** Mutate `params` in place to reflect `filters` (set when present, delete when empty). */
export function writeFacetsToParams(params: URLSearchParams, filters: FacetFilters): void {
  const apply = (key: string, values: string[]) => {
    if (values.length > 0) params.set(key, values.join(','));
    else params.delete(key);
  };
  apply(PARAM_ASSIGNEES, filters.assignees);
  apply(PARAM_PRIORITY, filters.priority);
  apply(PARAM_DUE, filters.due);
}

/** True when a URLSearchParams carries any facet key — used to decide seeding. */
export function paramsHaveFacets(params: URLSearchParams): boolean {
  return params.has(PARAM_ASSIGNEES) || params.has(PARAM_PRIORITY) || params.has(PARAM_DUE);
}

// ---------------------------------------------------------------------------
// localStorage persistence (per project)
// ---------------------------------------------------------------------------

export function facetsStorageKey(projectId: string): string {
  return `trueppm.board.${projectId}.facets`;
}

export function serializeFacets(filters: FacetFilters): string {
  return JSON.stringify(filters);
}

export function deserializeFacets(raw: string | null): FacetFilters {
  if (!raw) return EMPTY_FACETS;
  try {
    const parsed = JSON.parse(raw) as Partial<FacetFilters>;
    return {
      assignees: Array.isArray(parsed.assignees) ? parsed.assignees.filter((x) => typeof x === 'string') : [],
      priority: Array.isArray(parsed.priority)
        ? parsed.priority.filter((v): v is PriorityBand => (PRIORITY_BANDS as readonly string[]).includes(v))
        : [],
      due: Array.isArray(parsed.due)
        ? parsed.due.filter((v): v is DueWindow => (DUE_WINDOWS as readonly string[]).includes(v))
        : [],
    };
  } catch {
    return EMPTY_FACETS;
  }
}

/** Toggle a value inside one facet group, returning a new FacetFilters. */
export function toggleFacetValue<K extends keyof FacetFilters>(
  filters: FacetFilters,
  group: K,
  value: FacetFilters[K][number],
): FacetFilters {
  const current = filters[group] as string[];
  const next = current.includes(value as string)
    ? current.filter((v) => v !== value)
    : [...current, value as string];
  return { ...filters, [group]: next };
}

export const ALL_PRIORITY_BANDS = PRIORITY_BANDS;
export const ALL_DUE_WINDOWS = DUE_WINDOWS;
