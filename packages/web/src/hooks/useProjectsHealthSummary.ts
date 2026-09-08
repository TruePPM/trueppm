import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { HealthBand } from '@/lib/healthBand';
import type { HealthBandSource } from '@/types';

/**
 * Derived health band for a project in the "my projects" summary (ADR-0401).
 *
 * Re-exported from the one health vocabulary (`lib/healthBand`) rather than
 * redeclared, so a surface that widens the band set cannot leave this hook
 * describing a narrower one.
 */
export type { HealthBand };

export interface ProjectHealthRow {
  id: string;
  name: string;
  healthBand: HealthBand;
  /**
   * Which of the server's two branches produced `healthBand` (#3525). Needed
   * wherever the band is shown BESIDE the counts: a reported band is not
   * explained by them, so a drill-through built from the counts alone reads
   * "0 critical tasks" under a red dot.
   */
  healthBandSource: HealthBandSource;
  atRiskCount: number;
  criticalCount: number;
}

export interface UseProjectsHealthSummaryResult {
  data: ProjectHealthRow[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

interface ApiRow {
  id: string;
  name: string;
  health_band: HealthBand;
  health_band_source: HealthBandSource;
  at_risk_count: number;
  critical_count: number;
}

/**
 * GET /api/v1/projects/health-summary/ — a compact "my projects" health triage
 * for the My Work page (ADR-0401/#1941).
 *
 * One row per project the caller is a member of (archived excluded), each with a
 * derived health band plus the same at-risk / critical task counts the
 * single-project status-summary uses. Scoped server-side to the caller's own
 * projects — never a cross-program or portfolio rollup.
 */
export function useProjectsHealthSummary(): UseProjectsHealthSummaryResult {
  const query = useQuery({
    queryKey: ['projectsHealthSummary'],
    queryFn: async () => {
      const res = await apiClient.get<ApiRow[]>('/projects/health-summary/');
      // The endpoint returns a bare array; guard the shape so a paginated
      // ``{count,results}`` (e.g. an E2E catch-all route) degrades to "no projects"
      // rather than throwing and flashing a false error card on My Work.
      const rows = Array.isArray(res.data) ? res.data : [];
      return rows.map(
        (r): ProjectHealthRow => ({
          id: r.id,
          name: r.name,
          healthBand: r.health_band,
          healthBandSource: r.health_band_source,
          atRiskCount: r.at_risk_count,
          criticalCount: r.critical_count,
        }),
      );
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    // Suppress transient errors during the 401→token-refresh→retry cycle, matching
    // useProjects: the interceptor retries transparently while isFetching is true.
    error: query.isError && !query.isFetching ? query.error : null,
    refetch: () => void query.refetch(),
  };
}
