import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProjectDefaultView, ProjectHealth, ProjectVisibility } from '@/api/types';
import type { Methodology } from '@/types';

export interface ApiProjectDetail {
  id: string;
  server_version: number;
  name: string;
  description: string;
  start_date: string;
  /**
   * First working day on or after `start_date` — the effective schedule floor
   * (#884). The CPM engine floors task `early_start` here, so the before-start
   * prompt and "snap to project start" target this, not the literal start_date.
   * Equals `start_date` when the start is already a working day. Detail
   * responses only (ProjectDetailSerializer).
   */
  start_floor?: string;
  calendar: string | null;
  estimation_mode: string;
  agile_features: boolean;
  methodology: Methodology;
  /** Optional short code (uppercase A-Z, 0-9, hyphen; ≤12 chars). Empty when unset. */
  code: string;
  /** PM health override; AUTO defers to the (future) rollup. */
  health: ProjectHealth;
  /** Workspace or private listing scope. */
  visibility: ProjectVisibility;
  /** IANA timezone identifier; empty string defers to the workspace default. */
  timezone: string;
  /** Default landing view when the project is opened without one in the URL. */
  default_view: ProjectDefaultView;
  /** User id of the displayed project lead, or null when unset (#966). */
  lead: string | null;
  /** Read-only nested user payload for the lead — null when `lead` is null (#966). */
  lead_detail: { id: string; username: string; email: string } | null;
  /**
   * Iteration-container label OVERRIDE for this project (ADR-0111/0116). NULL =
   * inherit the program/workspace default. Display-only — never gates behavior.
   * To render the label use `useIterationLabel` (which reads the resolved value
   * below), not this raw override.
   */
  iteration_label: string | null;
  /**
   * Server-resolved effective label (ADR-0116, #1106): project override ??
   * program override ?? workspace default ?? "Sprint". This is the single value
   * clients render — the inheritance precedence lives on the server, not here.
   */
  effective_iteration_label: string;
  /**
   * Read-only label this project would show if its own override were cleared
   * (program ?? workspace default ?? "Sprint"). Drives the settings "Inherit (X)"
   * affordance (ADR-0116, #1106).
   */
  inherited_iteration_label: string;
  /** Sharing overrides (ADR-0135). null = inherit program/workspace value. */
  public_sharing: boolean | null;
  allow_guests: boolean | null;
  /** Read-only server-resolved effective values (project ?? program ?? workspace). */
  effective_public_sharing: boolean;
  effective_allow_guests: boolean;
  /** Read-only values inherited if the override were cleared (program ?? workspace). */
  inherited_public_sharing: boolean;
  inherited_allow_guests: boolean;
  /** Lifecycle (#530) — archived projects are hard read-only across all writes. */
  is_archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
  /**
   * Set by the CPM recalc task on success; null until the first schedule pass
   * completes after import (#1053). The Schedule view shows a non-blocking
   * "recalculating" badge while this is null on a sample project.
   */
  recalculated_at: string | null;
  /** True when this project is bundled demo data (#375 / #1053). */
  is_sample: boolean;
  /** The project's program as {id, name} — drives the per-project demo indicator's "part of …" link. Null for unassigned projects. */
  program_detail: { id: string; name: string } | null;
  /**
   * The caller's own Scrum-Master / Product-Owner team facets on this project
   * (ADR-0078 / #1095). Drives the render-gates for the sprint-goal edit (SM)
   * and the backlog manage controls (PO) — see `useMyFacets` / `useCanManageBacklog`.
   * Detail responses only; both false for non-facet members and anonymous reads.
   * Optional in the type so pre-#1095 fixtures need not set it; `useMyFacets`
   * defaults both facets to false when absent.
   */
  my_facets?: { is_scrum_master: boolean; is_product_owner: boolean };
}

/**
 * GET /api/v1/projects/{id}/ — fetch a single project's full record.
 *
 * Used by shell components (ViewTabs, BottomNav) that need methodology to
 * determine tab visibility. The `enabled` flag suppresses the request when
 * no projectId is in the route, avoiding a 404 on shell mount.
 */
export function useProject(projectId: string | null | undefined): UseQueryResult<ApiProjectDetail> {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ApiProjectDetail>(`/projects/${projectId}/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}
