import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { LinkType } from '@/types';
import type { PaginatedResponse } from '@/api/types';

interface ApiDependencyEdge {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: LinkType;
  lag: number;
}

export interface TaskDependencyEdge {
  id: string;
  predecessorId: string;
  successorId: string;
  depType: LinkType;
  lag: number;
}

export interface TaskDependenciesResult {
  predecessors: TaskDependencyEdge[];
  successors: TaskDependencyEdge[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * GET /api/v1/dependencies/?task=<id> — fetch all incoming and outgoing
 * dependency edges for a single task. Splits the result into predecessors
 * and successors based on the edge direction (board batch 3, ADR-0035).
 */
export function useTaskDependencies(taskId: string | null): TaskDependenciesResult {
  const query = useQuery({
    queryKey: ['task-dependencies', taskId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiDependencyEdge>>('/dependencies/', {
        params: { task: taskId },
      });
      return res.data.results;
    },
    enabled: !!taskId,
  });

  const edges: TaskDependencyEdge[] = (query.data ?? []).map((e) => ({
    id: e.id,
    predecessorId: e.predecessor,
    successorId: e.successor,
    depType: e.dep_type,
    lag: e.lag,
  }));

  return {
    predecessors: edges.filter((e) => e.successorId === taskId),
    successors: edges.filter((e) => e.predecessorId === taskId),
    isLoading: query.isLoading,
    error: query.error,
  };
}

export interface TaskRiskSummary {
  id: string;
  shortId: string;
  title: string;
  status: 'OPEN' | 'MITIGATING' | 'RESOLVED' | 'ACCEPTED' | 'CLOSED';
  severity: number;
  ownerId: string | null;
}

interface ApiRisk {
  id: string;
  short_id: string;
  title: string;
  status: TaskRiskSummary['status'];
  probability: number;
  impact: number;
  severity: number;
  owner: string | null;
}

/** GET /api/v1/projects/{project}/risks/?task=<id> — fetch risks linked to a task. */
export function useTaskRisks(
  projectId: string | null,
  taskId: string | null,
): { risks: TaskRiskSummary[]; isLoading: boolean; error: Error | null } {
  const query = useQuery({
    queryKey: ['task-risks', projectId, taskId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiRisk>>(
        `/projects/${projectId}/risks/`,
        { params: { task: taskId } },
      );
      return res.data.results;
    },
    enabled: !!projectId && !!taskId,
  });

  const risks: TaskRiskSummary[] = (query.data ?? []).map((r) => ({
    id: r.id,
    shortId: r.short_id,
    title: r.title,
    status: r.status,
    severity: r.severity,
    ownerId: r.owner,
  }));

  return {
    risks,
    isLoading: query.isLoading,
    error: query.error,
  };
}

// ---------------------------------------------------------------------------
// Severity bands — card-icon RAG mapping (collapses 5-tier register to 3-tier
// for icon-scale display; popover shows the full 5-tier).  ADR-0035 §Q2.
// ---------------------------------------------------------------------------

export type SeverityRagBand = 'green' | 'amber' | 'red';

/** Card icon color band: 1–5 green, 6–14 amber, 15–25 red. */
export function severityRagBand(severity: number | null | undefined): SeverityRagBand | null {
  if (severity == null || severity <= 0) return null;
  if (severity <= 5) return 'green';
  if (severity <= 14) return 'amber';
  return 'red';
}

/**
 * Severity dot count for the 5-tier register inside the popover.
 * Severity 1 = 1 dot (MINIMAL), 2-5 = 2 dots (LOW), 6-11 = 3 dots (MEDIUM),
 * 12-19 = 4 dots (HIGH), 20-25 = 5 dots (CRITICAL).
 * Color/dot pairing makes RAG accessible to color-blind users.
 */
export function severityDotCount(severity: number | null | undefined): number {
  if (severity == null || severity <= 0) return 0;
  if (severity === 1) return 1;
  if (severity <= 5) return 2;
  if (severity <= 11) return 3;
  if (severity <= 19) return 4;
  return 5;
}
