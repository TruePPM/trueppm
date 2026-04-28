import { useMemo } from 'react';
import { useResourceAllocation } from './useResourceAllocation';
import { parseUTCDate, formatISODate, addDays } from '@/features/resource/resourceUtils';

export interface OverallocationKeyParts {
  resourceId: string;
  taskId: string;
}

export interface BoardOverallocationResult {
  /** Keyed by `${resourceId}:${taskId}` → peak load factor (units / max_units) */
  overallocByPair: Map<string, number>;
  /** Threshold currently in use (default 1.0). */
  threshold: number;
  /** True when the resource-allocation endpoint returned 409 (schedule not run). */
  scheduleNotRun: boolean;
}

const DEFAULT_THRESHOLD = 1.0;

function readThreshold(): number {
  if (typeof window === 'undefined') return DEFAULT_THRESHOLD;
  try {
    const raw = window.localStorage.getItem('board:overallocThreshold');
    if (!raw) return DEFAULT_THRESHOLD;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_THRESHOLD;
    return parsed;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

function pairKey(resourceId: string, taskId: string): string {
  return `${resourceId}:${taskId}`;
}

/**
 * Compute peak load factor per (resource, task) for the board overallocation
 * badge (issue #184).  Reuses /projects/{id}/resource-allocation/ (ADR-0031)
 * so the board and resource timeline stay in sync.
 *
 * Honest scope (ADR-0035 §Q1): walks all weekdays in the task window; calendar
 * exceptions (CalendarException) are NOT applied.  A "1.4× during a vacation
 * week" false positive is acknowledged in the tooltip copy.
 */
export function useBoardOverallocation(projectId: string | null | undefined): BoardOverallocationResult {
  const allocation = useResourceAllocation(projectId ?? undefined);
  const threshold = readThreshold();

  const overallocByPair = useMemo<Map<string, number>>(() => {
    const out = new Map<string, number>();
    if (!allocation.data) return out;

    for (const resource of allocation.data.resources) {
      const max = parseFloat(resource.max_units);
      if (!Number.isFinite(max) || max <= 0) continue;

      // Build day → total_units across all tasks assigned to this resource.
      const dayUnits = new Map<string, number>();
      for (const t of resource.tasks) {
        if (!t.early_start || !t.early_finish) continue;
        const units = parseFloat(t.units);
        let cur = parseUTCDate(t.early_start);
        const end = parseUTCDate(t.early_finish);
        while (cur <= end) {
          const iso = formatISODate(cur);
          dayUnits.set(iso, (dayUnits.get(iso) ?? 0) + units);
          cur = addDays(cur, 1);
        }
      }

      // For each task: peak factor = max(dayUnits[day] / max) within its window.
      for (const t of resource.tasks) {
        if (!t.early_start || !t.early_finish) continue;
        let peak = 0;
        let cur = parseUTCDate(t.early_start);
        const end = parseUTCDate(t.early_finish);
        while (cur <= end) {
          const iso = formatISODate(cur);
          const units = dayUnits.get(iso) ?? 0;
          const factor = units / max;
          if (factor > peak) peak = factor;
          cur = addDays(cur, 1);
        }
        if (peak > threshold) {
          out.set(pairKey(resource.id, t.id), peak);
        }
      }
    }

    return out;
  }, [allocation.data, threshold]);

  return {
    overallocByPair,
    threshold,
    scheduleNotRun: allocation.status === 'schedule-not-run',
  };
}

export function getOverallocFactor(
  result: BoardOverallocationResult,
  resourceId: string,
  taskId: string,
): number | null {
  const factor = result.overallocByPair.get(pairKey(resourceId, taskId));
  return factor ?? null;
}
