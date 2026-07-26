import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * One distinct label name across a program's projects
 * (`GET /api/v1/programs/{id}/label-catalog/`, ADR-0638).
 *
 * `projectCount` is the number of **projects** carrying the name — not a task
 * count. That differs from the per-project facet (ADR-0620), where counts are
 * task counts computed over already-loaded rows, so the UI must label it
 * explicitly ("in 3 projects") rather than render a bare number that reads as
 * tasks.
 */
export interface ProgramLabelCatalogEntry {
  name: string;
  project_count: number;
}

export interface ProgramLabelCatalog {
  results: ProgramLabelCatalogEntry[];
  /** Projects in the program the viewer is not a member of — see `useProgramLabelTasks`. */
  withheld_project_count: number;
}

/** The label names available to filter by in this program. */
export function useProgramLabelCatalog(
  programId: string | null | undefined,
): UseQueryResult<ProgramLabelCatalog> {
  return useQuery({
    queryKey: ['program-label-catalog', programId],
    enabled: Boolean(programId),
    // The catalog changes only when someone adds or renames a label, which is
    // rare relative to how often this picker opens.
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiClient.get<ProgramLabelCatalog>(
        `/programs/${programId}/label-catalog/`,
      );
      return res.data;
    },
  });
}

/** A task row in the program label view. */
export interface ProgramLabelTask {
  id: string;
  short_id: string;
  name: string;
  wbs_path: string | null;
  status: string;
  percent_complete: number;
  early_finish: string | null;
  is_milestone: boolean;
  project: { id: string; name: string; code: string };
  /**
   * The task's own labels, each with the color from **its own project**. The
   * same label name legitimately renders in different colors on different rows
   * — colors are per-project (ADR-0400) and normalizing them would assert a
   * canonical answer that does not exist.
   */
  labels: { id: string; name: string; color: string }[];
}

export interface ProgramLabelTaskPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: ProgramLabelTask[];
  /**
   * How many of the program's projects were excluded because the viewer is not
   * a member of them. Program membership admits you to this view; project
   * membership governs what it reveals (ADR-0120 D5 / ADR-0638). Surfaced in the
   * UI because a silently partial list is a wrong answer presented as complete.
   */
  withheld_project_count: number;
}

/**
 * Tasks across the program's projects carrying `labelName` (case-insensitive).
 *
 * Disabled until a label is chosen: the endpoint fails closed with a 400 on a
 * missing label rather than dumping every task in the program, so firing without
 * one would only produce a guaranteed error.
 */
export function useProgramLabelTasks(
  programId: string | null | undefined,
  labelName: string | null | undefined,
): UseQueryResult<ProgramLabelTaskPage> {
  const label = (labelName ?? '').trim();
  return useQuery({
    queryKey: ['program-label-tasks', programId, label],
    enabled: Boolean(programId) && label.length > 0,
    queryFn: async () => {
      const params = new URLSearchParams({ label });
      const res = await apiClient.get<ProgramLabelTaskPage>(
        `/programs/${programId}/label-tasks/?${params.toString()}`,
      );
      return res.data;
    },
  });
}
