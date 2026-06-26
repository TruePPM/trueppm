import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { fetchAllPages } from '@/api/pagination';
import type { WorkspaceMember, WorkspaceInvite, PendingInvite } from '@/api/types';

// Re-export types so existing call sites that import from this module keep
// working without changing their import path.
export type { WorkspaceMember, PendingInvite };

/** snake_case shape of a member row from GET /workspace/members/ */
interface WorkspaceMemberRaw {
  id: string;
  name: string;
  initials: string;
  color: string;
  email: string;
  role: string;
  role_value: number;
  groups: string[];
  project_count: number;
  last_active: string | null;
  status: 'active' | 'guest' | 'deactivated';
  sso: boolean;
  two_fa: boolean;
}

/** snake_case shape of an invite row from GET /workspace/invites/ */
interface WorkspaceInviteRaw {
  id: string;
  email: string;
  role: string;
  role_value: number;
  status: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

function mapMember(raw: WorkspaceMemberRaw): WorkspaceMember {
  return {
    id: raw.id,
    name: raw.name,
    initials: raw.initials,
    color: raw.color,
    email: raw.email,
    role: raw.role,
    roleValue: raw.role_value,
    groups: raw.groups,
    projectCount: raw.project_count,
    lastActive: raw.last_active,
    status: raw.status,
    sso: raw.sso,
    twoFa: raw.two_fa,
  };
}

function mapInviteToWorkspaceInvite(raw: WorkspaceInviteRaw): WorkspaceInvite {
  return {
    id: raw.id,
    email: raw.email,
    role: raw.role,
    roleValue: raw.role_value,
    status: raw.status,
    invitedBy: raw.invited_by,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
  };
}

/** Maps an invite to the legacy PendingInvite shape the MembersPage renders. */
function mapInviteToPending(raw: WorkspaceInviteRaw): PendingInvite {
  return {
    id: raw.id,
    email: raw.email,
    role: raw.role,
    sentBy: raw.invited_by ?? '',
    sentAt: raw.created_at,
  };
}

/**
 * Returns workspace members and pending invites in the shape that
 * WorkspaceMembersPage consumes. Keeps the legacy { members, pendingInvites,
 * isLoading } return shape so the existing component tree doesn't change.
 */
export function useWorkspaceMembers() {
  const membersQuery = useQuery({
    queryKey: ['workspace-members'],
    queryFn: async () => {
      // /workspace/members/ is cursor-paginated (issue 1317); page through so the
      // members table still shows every member regardless of org size.
      const raw = await fetchAllPages<WorkspaceMemberRaw>('/workspace/members/');
      return raw.map(mapMember);
    },
  });

  const invitesQuery = useQuery({
    queryKey: ['workspace-invites'],
    queryFn: async () => {
      const res = await apiClient.get<WorkspaceInviteRaw[]>('/workspace/invites/');
      return res.data;
    },
  });

  const members = membersQuery.data ?? [];
  const pendingInvites: PendingInvite[] = (invitesQuery.data ?? []).map(mapInviteToPending);
  const isLoading = membersQuery.isLoading || invitesQuery.isLoading;

  return { members, pendingInvites, isLoading };
}

/** Exported so useWorkspaceInvites can reuse the raw → typed mapping. */
export { mapInviteToWorkspaceInvite };
export type { WorkspaceInviteRaw };
