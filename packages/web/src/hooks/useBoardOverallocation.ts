import { useMemo } from 'react';
import { useResourceAllocation } from './useResourceAllocation';
import {
  parseUTCDate,
  formatISODate,
  addDays,
  type AllocationResource,
  type AllocationTask,
} from '@/features/resource/resourceUtils';

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
    const parsed = Number.parseFloat(raw);
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
 * Invoke `visit` once per weekday (as an ISO date string) in the inclusive
 * [startIso, endIso] window. Calendar exceptions are NOT applied (ADR-0035 §Q1).
 * Shared by the two window walks below to keep each free of loop mechanics.
 */
function eachDayInWindow(startIso: string, endIso: string, visit: (iso: string) => void): void {
  let cur = parseUTCDate(startIso);
  const end = parseUTCDate(endIso);
  while (cur <= end) {
    visit(formatISODate(cur));
    cur = addDays(cur, 1);
  }
}

/**
 * Build day → total assigned units across every dated task of one resource.
 * Undated tasks (no early_start/finish) contribute nothing.
 */
function buildDayUnits(resource: AllocationResource): Map<string, number> {
  const dayUnits = new Map<string, number>();
  for (const t of resource.tasks) {
    if (!t.early_start || !t.early_finish) continue;
    const units = Number.parseFloat(t.units);
    eachDayInWindow(t.early_start, t.early_finish, (iso) => {
      dayUnits.set(iso, (dayUnits.get(iso) ?? 0) + units);
    });
  }
  return dayUnits;
}

/** Peak load factor (max daily units / max_units) within a task's own window. */
function peakFactor(task: AllocationTask, dayUnits: Map<string, number>, max: number): number {
  let peak = 0;
  eachDayInWindow(task.early_start as string, task.early_finish as string, (iso) => {
    const factor = (dayUnits.get(iso) ?? 0) / max;
    if (factor > peak) peak = factor;
  });
  return peak;
}

/**
 * Peak-load-factor map keyed by `${resourceId}:${taskId}`, retaining only pairs
 * whose peak exceeds `threshold`. Pure over the allocation payload so the hook's
 * `useMemo` body stays a single call.
 */
function computeOverallocByPair(
  resources: AllocationResource[],
  threshold: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const resource of resources) {
    const max = Number.parseFloat(resource.max_units);
    if (!Number.isFinite(max) || max <= 0) continue;

    const dayUnits = buildDayUnits(resource);
    for (const t of resource.tasks) {
      if (!t.early_start || !t.early_finish) continue;
      const peak = peakFactor(t, dayUnits, max);
      if (peak > threshold) {
        out.set(pairKey(resource.id, t.id), peak);
      }
    }
  }
  return out;
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
    if (!allocation.data) return new Map<string, number>();
    return computeOverallocByPair(allocation.data.resources, threshold);
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
