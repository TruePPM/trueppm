import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { HealthState } from '@/types';
import type { PaginatedResponse } from '@/api/types';

/**
 * A standalone (program-less) project as rendered in the Programs directory's
 * "Ungrouped projects" section (ADR-0083, #697). Enriched with the two
 * aggregates the API annotates only on the `?program__isnull=true` branch.
 */
export interface UngroupedProject {
  id: string;
  name: string;
  /** Short code; empty string when unset. */
  code: string;
  healthState: HealthState;
  /** Task-weighted mean progress (0–100), or null when the project has no tasks. */
  percentComplete: number | null;
  /** Active member count, or null when the API did not annotate it. */
  memberCount: number | null;
}

interface ApiUngroupedProject {
  id: string;
  name: string;
  code?: string;
  health?: string;
  percent_complete?: number | null;
  member_count?: number | null;
}

/**
 * Maps the server `health` enum (AUTO/ON_TRACK/AT_RISK/CRITICAL) to the web
 * `HealthState`. AUTO means "derive from the schedule", which is not computed
 * yet — surfaced as `unknown` so the dot is neutral rather than misleadingly green.
 */
function mapHealth(health: string | undefined): HealthState {
  switch (health) {
    case 'ON_TRACK':
      return 'on-track';
    case 'AT_RISK':
      return 'at-risk';
    case 'CRITICAL':
      return 'critical';
    default:
      return 'unknown';
  }
}

function mapUngrouped(p: ApiUngroupedProject): UngroupedProject {
  return {
    id: p.id,
    name: p.name,
    code: p.code ?? '',
    healthState: mapHealth(p.health),
    percentComplete: p.percent_complete ?? null,
    memberCount: p.member_count ?? null,
  };
}

/**
 * GET /api/v1/projects/?program__isnull=true — the current user's standalone
 * projects, RBAC-scoped to their memberships (ADR-0083).
 *
 * Keyed under `['projects', 'ungrouped']` so the existing
 * `useAssignProjectToProgram` invalidation of `['projects']` (a prefix match)
 * refreshes this list when a project is moved into a program.
 */
export function useUngroupedProjects(): UseQueryResult<UngroupedProject[]> {
  return useQuery({
    queryKey: ['projects', 'ungrouped'],
    queryFn: async () => {
      const res = await apiClient.get<
        PaginatedResponse<ApiUngroupedProject> | ApiUngroupedProject[]
      >('/projects/?program__isnull=true');
      const data = res.data;
      const rows = Array.isArray(data) ? data : data.results;
      return rows.map(mapUngrouped);
    },
  });
}
