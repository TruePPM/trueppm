import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Methodology, Project } from '@/types';

interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  methodology?: Methodology;
  program?: string | null;
  // Inheritance reads (ProjectSerializer, ADR-0107/0116) — used by the bulk-edit
  // matrix (issue 1233) to display effective values and the set-vs-inherited distinction.
  effective_methodology?: Methodology;
  inherited_methodology?: Methodology;
  iteration_label?: string | null;
  effective_iteration_label?: string | null;
  /** Per-project rollup counts annotated by this endpoint (issue 560). */
  overdue_count?: number | null;
  at_risk_count?: number | null;
}

/**
 * GET /api/v1/programs/{id}/projects/ — projects belonging to this program.
 *
 * Mirrors the shape returned by useProjects so the program-projects-tab table
 * can render identical rows. `colorDot` is omitted here — the program tab does
 * not use the 8-px sidebar dot.
 */
export function useProgramProjects(
  programId: string | undefined,
): UseQueryResult<Project[]> {
  return useQuery({
    queryKey: ['programs', programId, 'projects'],
    queryFn: async () => {
      const res = await apiClient.get<ApiProject[]>(`/programs/${programId}/projects/`);
      return res.data.map<Project>((p) => ({
        id: p.id,
        name: p.name,
        healthState: 'unknown',
        colorDot: '#6B6965', // neutral until the projects list assigns a palette color
        methodology: p.methodology ?? 'HYBRID',
        programId: p.program ?? programId ?? null,
        openTaskCount: null, // not annotated on the program-projects endpoint
        iterationLabel: p.iteration_label ?? null,
        effectiveIterationLabel: p.effective_iteration_label ?? null,
        effectiveMethodology: p.effective_methodology ?? p.methodology ?? 'HYBRID',
        inheritedMethodology: p.inherited_methodology,
        overdueCount: p.overdue_count ?? null,
        atRiskCount: p.at_risk_count ?? null,
      }));
    },
    enabled: !!programId,
  });
}
