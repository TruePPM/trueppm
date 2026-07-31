import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * One task row from `GET /api/v1/programs/{id}/task-search/` (ADR-0120 D5).
 *
 * Deliberately slim — no cost, status, assignee, or points. The endpoint only
 * returns tasks in member projects the caller can read, so this is safe to
 * render directly in the cross-project dependency picker.
 */
export interface ProgramTaskResult {
  id: string;
  name: string;
  /**
   * Raw 8-hex-digit project-scoped sequence (ADR-0016 / issue #50). **Do not
   * render it** — it reads as an internal identifier (`00000008`) rather than
   * "the eighth task" (#2430, #2671). Use `qualified_id` (preferred, and the
   * form that actually disambiguates two sibling projects' task 3) or
   * `short_id_display`.
   */
  short_id: string;
  /** Server-formatted compact task reference, e.g. `"T-8"` (#2671). */
  short_id_display?: string;
  /** Server-formatted project-qualified task reference, e.g. `"ENG-2026-8"` —
   *  the preferred form here, since every row in this cross-project search is
   *  from a *different* project than the caller's own (#2671). */
  qualified_id?: string;
  project_id: string;
  project_name: string;
}

/**
 * Search tasks across a program's projects to pick a cross-project dependency
 * counterpart (ADR-0120). The per-project schedule picker is single-project;
 * this backs its "Program" scope, returning sibling-project tasks the caller
 * can read (the current project is excluded via `excludeProjectId` — its tasks
 * are already local).
 *
 * The query is disabled until there is a program, a non-empty term, and (by the
 * caller) a debounced input — the server caps the term at 100 chars and returns
 * `[]` for a blank one, but gating here avoids a request per keystroke.
 */
export function useProgramTaskSearch(
  programId: string | null | undefined,
  query: string,
  excludeProjectId: string | null | undefined,
): UseQueryResult<ProgramTaskResult[]> {
  const q = query.trim();
  return useQuery({
    queryKey: ['program-task-search', programId, excludeProjectId, q],
    enabled: Boolean(programId) && q.length > 0,
    // Results are a search convenience, not authoritative state; a short stale
    // window keeps repeated searches for the same term instant without pinning
    // a stale sibling-project task list open across a long picker session.
    staleTime: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams({ q });
      if (excludeProjectId) params.set('exclude_project', excludeProjectId);
      const res = await apiClient.get<ProgramTaskResult[]>(
        `/programs/${programId}/task-search/?${params.toString()}`,
      );
      return res.data;
    },
  });
}
