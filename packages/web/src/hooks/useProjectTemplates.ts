import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, ProgramMethodology } from '@/api/types';

/**
 * A template as the gallery sees it (ADR-0789, #2729).
 *
 * Note what is NOT here: `structure`. The server does not publish the document on
 * the gallery endpoint — a gallery reader is a wider audience than the source
 * project's members, so a whole project's shape (task names included) must not
 * ride the list. `taskCount` is the server's own count off the frozen document,
 * which is why it can never disagree with what apply will write. `methodology`
 * (ADR-0791, #2728) is likewise read off the frozen document server-side — a
 * three-value enum, never the document itself — so the Start sheet can derive its
 * "this project will carry these views" line for a chosen template without a
 * second request.
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
  /**
   * The source project's methodology at publish time (ADR-0791). Never null —
   * the server falls back to `HYBRID` for a structure written before this field
   * existed, the same lossless default the rest of the methodology chain uses.
   */
  methodology: ProgramMethodology;
  task_count: number;
  version: number;
  program: string | null;
  published_at: string;
  /**
   * Counts off the frozen structure document (#2909) — server-side because the
   * publish inventory and the gallery's carries summary are both screens whose
   * credibility rests on a number, and a client-side walk of a filtered tree
   * would produce a different one. Absent on a row read before #2909.
   */
  counts?: TemplateCounts;
  /**
   * Projects created from this template, excluding undone applications. The
   * PMO's only evidence that a shape is actually the house standard rather than
   * somebody's experiment.
   */
  usage_count?: number;
  published_by_name?: string;
  source_project?: string | null;
  /** '' once the source project is deleted — the provenance line drops, the template works. */
  source_project_name?: string;
  supersedes?: string | null;
  /** A later version replaced this. It stays selectable: projects already
   *  created from it are why it must remain legible. */
  is_superseded?: boolean;
}

/** What publishing this shape would carry. */
export interface TemplateCounts {
  task_count: number;
  phase_count: number;
  gate_count: number;
  milestone_count: number;
  dependency_count: number;
  methodology: ProgramMethodology | null;
  carries: string[];
}

/** The publish dry run, plus whether the proposed name is already taken. */
export interface PublishPreview extends TemplateCounts {
  name_taken: boolean;
  next_version: number;
  existing_template: string | null;
}

export interface TemplateApplication {
  id: string;
  template: string | null;
  template_name: string;
  template_version: number;
  project: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'undone';
  /**
   * `tasks_created`/`milestones_created`/`dependencies_created` are read off what
   * `materialize_structure` already built in memory at apply time (ADR-0799 §2) —
   * the seed banner (#2731) reads these rather than re-deriving them client-side
   * from the full task list, which would be a second, driftable definition of the
   * same counts. Absent on an application applied before #2731 shipped.
   */
  result_summary: {
    tasks_created?: number;
    milestones_created?: number;
    dependencies_created?: number;
    undo?: { deleted: number; kept: number };
  };
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

/**
 * POST /api/v1/tasks/delete-untouched-seeded/ — "Delete untouched rows (N)" (#2731,
 * ADR-0799 §3).
 *
 * Carries only the project id. The server recomputes the untouched-seeded set from
 * provenance (`seeded_at`/`edited_at`, #2730) rather than accepting an id list —
 * ADR-0773 §4 forbids the client-supplied-list shape outright, since the
 * affordance's safety is entirely "the server asserts these were never touched."
 */
export function useDeleteUntouchedSeededTasks() {
  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await apiClient.post<{ deleted: number }>('/tasks/delete-untouched-seeded/', {
        project: projectId,
      });
      return res.data;
    },
  });
}


/**
 * `GET /project-templates/publish-preview/` — the six counts, before the form.
 *
 * Runs the same extraction `publish` runs, so the numbers on the confirm screen
 * are the numbers that will be written. Passing `name` also reports whether it
 * is taken, so the form can offer "publish as v3 instead" up front rather than
 * after a 409.
 */
export function usePublishPreview(
  projectId: string | null,
  name?: string,
): UseQueryResult<PublishPreview> {
  return useQuery({
    queryKey: ['template-publish-preview', projectId, name ?? ''],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await apiClient.get<PublishPreview>('/project-templates/publish-preview/', {
        params: { project: projectId, ...(name ? { name } : {}) },
      });
      return res.data;
    },
  });
}

/** A 409 from publish: the name exists, and this is the version that would replace it. */
export interface TemplateNameTaken {
  code: 'name_taken';
  detail: string;
  template: string;
  version: number;
  next_version: number;
}

/**
 * `POST /project-templates/publish/` — freeze a project's shape.
 *
 * A taken name comes back as a **409**, not a silent overwrite: republishing
 * writes a new row and leaves the old one selectable, because the projects
 * already created from v1 are the only audit trail a PMO has for why they look
 * the way they do. Pass `newVersion` to take that branch deliberately.
 */
export function usePublishTemplate() {
  return useMutation({
    mutationFn: async (vars: {
      projectId: string;
      name: string;
      description?: string;
      sourceKind?: ProjectTemplate['source_kind'];
      newVersion?: boolean;
    }) => {
      const res = await apiClient.post<ProjectTemplate>('/project-templates/publish/', {
        project: vars.projectId,
        name: vars.name,
        description: vars.description ?? '',
        ...(vars.sourceKind ? { source_kind: vars.sourceKind } : {}),
        ...(vars.newVersion ? { new_version: true } : {}),
      });
      return res.data;
    },
  });
}

/**
 * How this project has diverged from the template it was created from (#2971).
 *
 * Every field is server-computed. Nothing here is derived client-side, and that is
 * the point rather than a convention: the whole feature is a report about a team's
 * own decisions, and a browser that re-counted the rows would be a second definition
 * of "untouched" competing with the one the server deletes rows by (ADR-0786 §3).
 */
export interface TemplateDivergence {
  project: string;
  /** False when this project was not created from a template — an answer, not an error. */
  adopted: boolean;
  application: string | null;
  /** Adoptions that seeded rows here, excluding undone ones. Usually 1. */
  application_count: number;
  /** Null once the template row itself is deleted; `template_name` survives it. */
  template: string | null;
  template_name: string;
  template_version: number;
  /** False means the template is gone, not that the adoption is in doubt. */
  template_available: boolean;
  applied_at: string | null;
  /** '' once the adopter's account is deleted — never a fabricated placeholder. */
  applied_by_name: string;
  seeded_row_count: number;
  /** Seeded, still here, nobody has touched it. */
  unchanged: number;
  /** Seeded and since edited. The number this whole feature exists to keep neutral. */
  adapted: number;
  /**
   * A template row that has since been soft-deleted. A row hard-deleted by the
   * tombstone reap is not counted — nothing can count it.
   */
  removed: number;
  /** Live rows no adoption wrote — including any that predate the template. */
  added: number;
}

/**
 * `GET /projects/{id}/template-divergence/` — the digest, for anyone on the project.
 *
 * There is no audience parameter and no second endpoint. A PMO reading one project's
 * divergence and that project's team reading their own fire the identical request and
 * receive the identical body, which is how the symmetry requirement in epic #2743 is
 * kept true by construction rather than by two surfaces agreeing to stay in step.
 */
export function useTemplateDivergence(
  projectId: string | null,
): UseQueryResult<TemplateDivergence> {
  return useQuery({
    queryKey: ['template-divergence', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await apiClient.get<TemplateDivergence>(
        `/projects/${projectId}/template-divergence/`,
      );
      return res.data;
    },
  });
}

/** Templates published from one project — the Settings page's version list. */
export function useTemplatesFromProject(projectId: string | null): UseQueryResult<ProjectTemplate[]> {
  return useQuery({
    queryKey: ['project-templates-from', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ProjectTemplate> | ProjectTemplate[]>(
        '/project-templates/',
      );
      const data = res.data;
      const rows = Array.isArray(data) ? data : data.results;
      // Filtered client-side: the gallery endpoint has no source-project filter,
      // and adding one for a list this small would be a wider API change than
      // the screen needs.
      return rows.filter((t) => t.source_project === projectId);
    },
  });
}
