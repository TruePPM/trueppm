import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type {
  DurationChangePercentPolicy,
  EstimationMode,
  MCAttributionAudience,
  PaginatedResponse,
  PrioritizationModel,
  ProjectDefaultView,
  ProjectHealth,
  ProjectVisibility,
} from '@/api/types';
import type { BoardCadence, Methodology } from '@/types';

interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string | null;
  methodology?: Methodology;
  code?: string;
  health?: ProjectHealth;
  visibility?: ProjectVisibility;
  timezone?: string;
  default_view?: ProjectDefaultView;
}

// ---------------------------------------------------------------------------
// useCreateProject — POST /api/v1/projects/
// ---------------------------------------------------------------------------

export interface CreateProjectPayload {
  name: string;
  start_date: string;
  description?: string;
  /** Project planning methodology (ADR-0041). Server defaults to HYBRID when omitted. */
  methodology?: Methodology;
  // `agile_features` is intentionally not settable: it is derived server-side from
  // effective_methodology (#1766), so it is a read-only field on the project detail,
  // never part of the create payload.
  /** Optional Program assignment at creation time (ADR-0070). Requires ADMIN on the target program. */
  program?: string;
  /**
   * Optional source project to seed settings from at create time (copy-at-create,
   * #157 / ADR-0242). UUID of a project the caller can read; the server copies the
   * source's stored settings (calendar, default view, board cadence, visibility,
   * sharing/attachment/Monte Carlo policies, etc.). Precedence is explicit request
   * value > copied > default, so any field also sent in this payload still wins.
   * Omit for today's blank-defaults behavior.
   */
  copy_settings_from?: string;
  /**
   * Opt-in to seed the new project's `methodology` and `visibility` from its parent
   * program at create time (copy-at-create, #1909 / #157). Requires `program` to be
   * set (the caller must be ADMIN on it — server-enforced) and is mutually exclusive
   * with `copy_settings_from`. A one-time manual copy, not locked inheritance:
   * the seeded values are owned by the new project and editable afterward.
   */
  inherit_program_defaults?: boolean;
  /**
   * Default RBAC role for members later added without an explicit role (ADR-0363,
   * #157). A `ROLE_*` ordinal below Owner; server defaults to `ROLE_MEMBER`.
   */
  default_member_role?: number;
}

/** POST /api/v1/projects/ — create a new project and invalidate the project list cache. */
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateProjectPayload) => {
      const res = await apiClient.post<ApiProject>('/projects/', payload);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateProject — PATCH /api/v1/projects/:id/
// ---------------------------------------------------------------------------

export interface UpdateProjectPayload {
  name?: string;
  description?: string;
  /** Short code; empty string clears it. Server validates uppercase A-Z, 0-9, hyphen, ≤12 chars. */
  code?: string;
  /** PM health override; AUTO defers to the (future) rollup. */
  health?: ProjectHealth;
  /** Workspace or private listing scope. */
  visibility?: ProjectVisibility;
  /** IANA timezone identifier; empty string defers to the workspace default. */
  timezone?: string;
  /** Default landing view (SCHEDULE | BOARD | TABLE | OVERVIEW). */
  default_view?: ProjectDefaultView;
  /**
   * Default RBAC role for members added without an explicit role (ADR-0363, #157).
   * A `ROLE_*` ordinal strictly below Owner; rejected server-side otherwise.
   * Admin+-only (settings-field allowlist default in the serializer).
   */
  default_member_role?: number;
  /**
   * Per-project methodology override (ADR-0107, issue 955). Always a concrete
   * value (no inherit sentinel — inheritance is governed by the workspace policy,
   * not override-presence). Rejected with 403 server-side when the workspace
   * locks overrides (INHERIT, or Enterprise ENFORCE). Admin+-only.
   */
  methodology?: Methodology;
  /**
   * Board cadence (ADR-0164, issue 410). `sprint` shows sprint chrome on the board;
   * `continuous` hides it for continuous-flow Kanban. Scheduler+-writable (in the
   * serializer allowlist alongside methodology). Not an inheritable override.
   */
  board_cadence?: BoardCadence;
  /**
   * Estimate-governance mode (ADR-0041, #2018). Scheduler+-writable server-side
   * (in the serializer `_SCHEDULER_WRITABLE_FIELDS` allowlist alongside methodology).
   */
  estimation_mode?: EstimationMode;
  /**
   * Iteration-container label override (ADR-0111/0116). Singular noun, ≤32 chars;
   * `null` clears the override so the project inherits the program/workspace default.
   * Admin+-only server-side (allowlist default in the serializer).
   */
  iteration_label?: string | null;
  /** Sharing overrides (ADR-0135). `null` clears the override so the project
   *  inherits the program/workspace value. Admin+-only server-side. */
  public_sharing?: boolean | null;
  allow_guests?: boolean | null;
  /** Forecast-history overrides (ADR-0144, issue 1232). `null` clears the override so
   *  the project inherits the program/workspace value. Admin+-only server-side. */
  mc_history_enabled?: boolean | null;
  mc_history_retention_cap?: number | null;
  mc_history_attribution_audience?: MCAttributionAudience | null;
  /** Percent-complete-on-duration-change policy override (ADR-0151, issue 1254).
   *  `null` clears the override so the project inherits the program/workspace value.
   *  Admin+-only server-side. */
  task_duration_change_percent_policy?: DurationChangePercentPolicy | null;
  /** Attachment-policy overrides (ADR-0153, issue 976). `attachments_enabled`: `null`
   *  clears the override so the project inherits the program/workspace value.
   *  `allowed_attachment_types` is tri-state: `null` = inherit, `[]` = explicit
   *  empty, `[...]` = explicit allow-list. Admin+-only server-side; the security
   *  denylist is rejected on write. */
  attachments_enabled?: boolean | null;
  allowed_attachment_types?: string[] | null;
  /** Calendar UUID or null to inherit from the workspace. */
  calendar?: string | null;
  /** Project lead — user id, or null to unassign. Admin+-only and must already
   *  be a project member; both enforced server-side (#966). */
  lead?: string | null;
  /** Project start date (ISO `YYYY-MM-DD`). Admin+-only server-side (#769). */
  start_date?: string;
  /** Forecasting data date (ADR-0132, #2018). ISO `YYYY-MM-DD`, or `null` for
   *  "today (dynamic)". Admin+-only server-side. */
  status_date?: string | null;
  /** Backlog prioritization scoring model (ADR-0105, #2018). Admin+-only server-side. */
  prioritization_model?: PrioritizationModel;
  /** Stale-task notification threshold in days (ADR-0200, #2018). 1–365. Admin+-only. */
  stale_task_threshold_days?: number;
  /** End-date-shift notification threshold in days (#1911, #2018). 1–365. Admin+-only. */
  end_date_shift_threshold_days?: number;
  /**
   * Independent leaf-surface visibility overrides (ADR-0193, issue 956). `null`
   * clears the override so the project inherits the methodology default. Admin+-only
   * server-side. Hide-only (ADR-0041) — the endpoint and route stay reachable.
   */
  show_reporting?: boolean | null;
  show_time_tracking?: boolean | null;
  show_baselines?: boolean | null;
  show_monte_carlo?: boolean | null;
}

/**
 * PATCH /api/v1/projects/:id/ — update editable project fields and invalidate
 * the project detail + list caches. Used by the settings save bar (#536) for
 * the Project General page. All seven editable fields (name, description,
 * code, health, visibility, timezone, default_view, calendar) layer on the
 * same call; the save bar batches dirty edits into one PATCH on submit.
 */
export function useUpdateProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateProjectPayload) => {
      if (!projectId) throw new Error('projectId is required');
      const res = await apiClient.patch<ApiProject>(`/projects/${projectId}/`, payload);
      return res.data;
    },
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useCalendars — GET /api/v1/calendars/ (optional; used to offer a picker)
// ---------------------------------------------------------------------------

export interface ApiCalendar {
  id: string;
  name: string;
}

/** GET /api/v1/calendars/ — fetch available calendars for the project creation picker. */
export function useCalendars() {
  return useQuery({
    queryKey: ['calendars'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiCalendar>>('/calendars/');
      return res.data.results;
    },
  });
}

// ---------------------------------------------------------------------------
// Project lifecycle (#530) — archive / unarchive / transfer / delete
// ---------------------------------------------------------------------------

/** POST /api/v1/projects/:id/archive/ — mark a project read-only. Owner only. */
export function useArchiveProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('projectId is required');
      const res = await apiClient.post<ApiProject>(`/projects/${projectId}/archive/`);
      return res.data;
    },
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** POST /api/v1/projects/:id/unarchive/ — restore writes to an archived project. */
export function useUnarchiveProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('projectId is required');
      const res = await apiClient.post<ApiProject>(`/projects/${projectId}/unarchive/`);
      return res.data;
    },
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export interface TransferProjectPayload {
  new_owner_user_id: string;
}

/** POST /api/v1/projects/:id/transfer/ — hand ownership to another member. */
export function useTransferProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: TransferProjectPayload) => {
      if (!projectId) throw new Error('projectId is required');
      const res = await apiClient.post<ApiProject>(`/projects/${projectId}/transfer/`, payload);
      return res.data;
    },
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
        void queryClient.invalidateQueries({ queryKey: ['project-members', projectId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/**
 * DELETE /api/v1/projects/:id/ — soft-delete by default; pass ``force=true``
 * for a permanent hard delete (requires the project to already be archived).
 */
export function useDeleteProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ force = false }: { force?: boolean } = {}) => {
      if (!projectId) throw new Error('projectId is required');
      const url = force ? `/projects/${projectId}/?force=true` : `/projects/${projectId}/`;
      await apiClient.delete(url);
    },
    onSuccess: () => {
      if (projectId) {
        void queryClient.removeQueries({ queryKey: ['project', projectId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['projects-trash'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Trash + restore (issue 1113, ADR-0202)
// ---------------------------------------------------------------------------

/** One soft-deleted project as returned by GET /api/v1/projects/trash/. */
export interface TrashProject {
  id: string;
  name: string;
  code: string;
  /** ISO timestamp of the soft delete, or null for a legacy tombstone (retained indefinitely). */
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_by_name: string | null;
  /** Days left before the retention purge; null when deleted_at is null or retention is disabled. */
  days_remaining: number | null;
  /** Effective retention window in days, or null when purging is disabled. */
  retention_days: number | null;
  /** Caller's role ordinal on the project (Role enum). */
  my_role: number | null;
  /** True only when the caller is the Owner — the web disables Restore otherwise. */
  can_restore: boolean;
}

/** GET /api/v1/projects/trash/ — the caller's soft-deleted projects within the retention window. */
export function useTrashedProjects() {
  return useQuery({
    queryKey: ['projects-trash'],
    queryFn: async () => {
      const res = await apiClient.get<TrashProject[]>('/projects/trash/');
      return res.data;
    },
  });
}

/**
 * POST /api/v1/projects/:id/restore/ — un-tombstone a soft-deleted project and its
 * children atomically. Owner only. Not bound to a fixed projectId because the caller
 * (Trash list, Undo toast) restores an id chosen at call time.
 */
export function useRestoreProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await apiClient.post<ApiProject>(`/projects/${projectId}/restore/`);
      return res.data;
    },
    onSuccess: (_data, projectId) => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['projects-trash'] });
    },
  });
}
