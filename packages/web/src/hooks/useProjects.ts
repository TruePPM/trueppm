import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { HealthState, Methodology, Project } from '@/types';
import type { PaginatedResponse } from '@/api/types';

/** Server health enum (projects.models.Health) values that map to a colored dot.
 *  AUTO (the default, "defer to rollup") and any unknown value stay hollow. */
type ApiHealth = 'AUTO' | 'ON_TRACK' | 'AT_RISK' | 'CRITICAL';

const HEALTH_STATE: Record<ApiHealth, HealthState> = {
  AUTO: 'unknown',
  ON_TRACK: 'on-track',
  AT_RISK: 'at-risk',
  CRITICAL: 'critical',
};

function toHealthState(health: string | undefined): HealthState {
  return HEALTH_STATE[health as ApiHealth] ?? 'unknown';
}

export interface UseProjectsResult {
  data: Project[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string;
  methodology?: Methodology;
  /** Optional program FK (ADR-0070). Null for standalone projects. */
  program?: string | null;
  /** PM/rollup health enum — mapped to the row's health dot. */
  health?: string;
  /** Count of non-deleted, not-yet-complete tasks (annotated on the list). */
  open_task_count?: number | null;
}

// Deterministic palette cycled by index — no server-side color assignment yet.
// Values are Design System hex literals kept here as the canonical definition
// (components must not reference this array directly — they consume Project.colorDot).
const COLOR_PALETTE: ReadonlyArray<string> = [
  '#3E8C6D',
  '#E8A020',
  '#B91C1C',
  '#6B6965',
  '#316F57',
  '#1D4ED8',
  '#7C3AED',
  '#0E7490',
];

function mapProject(p: ApiProject, index: number): Project {
  return {
    id: p.id,
    name: p.name,
    // Server health enum → dot state; AUTO/unset stays hollow ('unknown').
    healthState: toHealthState(p.health),
    openTaskCount: p.open_task_count ?? null,
    // The modulo guarantees index is in bounds; fallback keeps TS happy on the readonly array type
    colorDot: COLOR_PALETTE[index % COLOR_PALETTE.length] ?? '#3E8C6D',
    // Default to HYBRID for projects created before ADR-0041 landed (preserves
    // pre-methodology behavior — all tabs visible).
    methodology: p.methodology ?? 'HYBRID',
    programId: p.program ?? null,
  };
}

/**
 * GET /api/v1/projects/ — fetch the current user's project list.
 *
 * Suppresses error state during the 401→token-refresh→retry cycle to prevent
 * a "Failed to load" flash while the interceptor silently retries the request.
 * colorDot is assigned client-side from a deterministic palette (no server color);
 * healthState and openTaskCount are mapped from the server's annotated list row.
 */
export function useProjects(): UseProjectsResult {
  const query = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiProject>>('/projects/');
      return res.data.results.map(mapProject);
    },
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    // Suppress transient errors during the 401→token-refresh→retry cycle:
    // the axios interceptor retries transparently, so query.isFetching is true
    // while the retry is in flight. Showing an error during that window causes
    // a visible "Failed to load projects" flash even though the retry succeeds.
    error: query.isError && !query.isFetching ? query.error : null,
  };
}
