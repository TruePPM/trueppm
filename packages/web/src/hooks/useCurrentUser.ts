import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

/**
 * Role-based app front door (ADR-0129). The server resolves *where* a user lands
 * and the client only navigates — it holds no role→surface policy. These unions
 * mirror the server contract on `/auth/me/`:
 *   - DefaultLanding: the user's stored preference ("auto" if unset). Writable
 *     via PATCH /auth/me/profile/.
 *   - LandingIntent: the stable semantic target the server resolved to.
 *   - LandingResolvedBy: how the front door was decided — drives honest
 *     first-login / "why am I here?" affordances.
 */
export type DefaultLanding = 'auto' | 'my_work' | 'project_overview' | 'portfolio';
export type LandingIntent = 'my_work' | 'project_overview' | 'portfolio';
export type LandingResolvedBy = 'preference' | 'role_policy' | 'fallback';
/**
 * Active role-context "lens" (issue 412, ADR-0162). A presentation-only preference:
 * it picks a dual-hat user's default project view and the view-tab emphasis. It
 * NEVER gates access — RBAC stays the sole authority. `unified` is the neutral
 * default. Writable via PATCH /auth/me/profile/.
 */
export type RoleContext = 'pm' | 'scrum_master' | 'unified';

export interface CurrentUser {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  email: string;
  /**
   * Contributor-tier role signal (#855/#856, ADR-0122). Server-computed so the
   * client gates admin chrome on one boolean instead of fanning out per-project
   * membership lookups.
   *   - max_project_role: highest project Role ordinal across memberships (null
   *     if the user belongs to no projects).
   *   - workspace_role: WorkspaceRole ordinal (null if no workspace membership).
   *   - can_access_admin_settings: Admin+ in any project OR Admin+ at the
   *     workspace — gates the settings shell admin scopes and the Signal-only
   *     notification default.
   */
  max_project_role: number | null;
  workspace_role: number | null;
  can_access_admin_settings: boolean;
  /**
   * Role-based app front door (ADR-0129). `default_landing` is the user's stored
   * preference; `landing` is the server-resolved destination the client
   * navigates to (`path`), tagged with the semantic `intent` and a `resolved_by`
   * explaining the decision.
   */
  default_landing: DefaultLanding;
  landing: {
    intent: LandingIntent;
    path: string;
    resolved_by: LandingResolvedBy;
  };
  /**
   * Per-user nav visibility (ADR-0139). Canonical view keys the user has hidden
   * from their own project view bar, applied globally and layered on top of the
   * per-project methodology preset. Absent/empty = methodology default only.
   */
  hidden_views: string[];
  /**
   * Active role-context lens (issue 412, ADR-0162) — `unified` if unset. Read so the
   * shell can reflect/respect the stored lens without a flash of the wrong view.
   */
  role_context: RoleContext;
}

/**
 * Fetches GET /api/v1/auth/me/ and returns the current user's identity.
 * staleTime: 5 min — matches access token lifetime; avoids redundant refetches.
 */
export function useCurrentUser(): { user: CurrentUser | undefined; isLoading: boolean } {
  const { data, isPending } = useQuery<CurrentUser, AxiosError>({
    queryKey: ['current-user'],
    queryFn: async () => {
      const res = await apiClient.get<CurrentUser>('/auth/me/');
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return { user: data, isLoading: isPending };
}
