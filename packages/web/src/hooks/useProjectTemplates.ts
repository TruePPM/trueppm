import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

/**
 * A template as the gallery sees it (ADR-0789, #2729).
 *
 * Note what is NOT here: `structure`. The server does not publish the document on
 * the gallery endpoint — a gallery reader is a wider audience than the source
 * project's members, so a whole project's shape (task names included) must not
 * ride the list. `taskCount` is the server's own count off the frozen document,
 * which is why it can never disagree with what apply will write.
 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** Stored provenance tier. Prefer `provenance` for display. */
  source_kind: 'workspace' | 'community' | 'personal';
  /**
   * The chip label the server resolved for *this* reader — "Workspace",
   * "Community", or "Yours". Server-side because only it knows whether a personal
   * template belongs to the person asking; a client deriving it would show "Yours"
   * on somebody else's skeleton.
   */
  provenance: string;
  /** What this template carries — `structure`, `dependencies`, `durations`, … */
  carries: string[];
  task_count: number;
  version: number;
  program: string | null;
  published_at: string;
}

export interface TemplateApplication {
  id: string;
  template: string | null;
  template_name: string;
  template_version: number;
  project: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'undone';
  result_summary: { tasks_created?: number; undo?: { deleted: number; kept: number } };
  error_detail: string;
  created_at: string;
  completed_at: string | null;
  undone_at: string | null;
}

/**
 * GET /api/v1/project-templates/ — the gallery.
 *
 * Scoped to a program when one is given: the server returns that program's own
 * templates *plus* the workspace-wide ones, because a program gallery that hid
 * the shared skeletons reads as empty and pushes people to republish duplicates.
 */
export function useProjectTemplates(programId?: string | null): UseQueryResult<ProjectTemplate[]> {
  return useQuery({
    queryKey: ['project-templates', programId ?? null],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ProjectTemplate> | ProjectTemplate[]>(
        '/project-templates/',
        { params: programId ? { program: programId } : undefined },
      );
      const data = res.data;
      return Array.isArray(data) ? data : data.results;
    },
  });
}

/**
 * POST /api/v1/project-templates/{id}/apply/ — queue a seeding job.
 *
 * Resolves with the **application id**, not a Celery task id. Dispatch is
 * best-effort behind an outbox, so there may be no task id yet — or ever, for the
 * delivery the drain re-dispatches. The application id exists the moment the
 * request commits and is the durable handle to poll.
 */
export function useApplyTemplate() {
  return useMutation({
    mutationFn: async (vars: { templateId: string; projectId: string }) => {
      const res = await apiClient.post<{ queued: boolean; application: string }>(
        `/project-templates/${vars.templateId}/apply/`,
        { project: vars.projectId },
      );
      return res.data;
    },
  });
}

/**
 * POST /api/v1/template-applications/{id}/undo/ — reverse an application.
 *
 * A single step from the user's side. The server keeps any row a person has since
 * edited and reports how many in `undo.kept`, so the UI can say so rather than
 * claiming a clean reversal it did not perform.
 */
export function useUndoTemplateApplication() {
  return useMutation({
    mutationFn: async (applicationId: string) => {
      const res = await apiClient.post<TemplateApplication & { undo: { deleted: number; kept: number } }>(
        `/template-applications/${applicationId}/undo/`,
        {},
      );
      return res.data;
    },
  });
}

/**
 * GET /api/v1/template-applications/{id}/ — poll a running application.
 *
 * `enabled` is the caller's gate; polling stops once the status is terminal so a
 * finished apply does not keep a timer alive for the life of the page.
 */
export function useTemplateApplication(
  applicationId: string | null,
): UseQueryResult<TemplateApplication> {
  return useQuery({
    queryKey: ['template-application', applicationId],
    enabled: Boolean(applicationId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 2000 : false;
    },
    queryFn: async () => {
      const res = await apiClient.get<TemplateApplication>(
        `/template-applications/${applicationId}/`,
      );
      return res.data;
    },
  });
}
