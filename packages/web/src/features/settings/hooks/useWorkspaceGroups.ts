import { useQuery } from '@tanstack/react-query';
import { fetchAllPages } from '@/api/pagination';
import type { WorkspaceGroup, WorkspaceGroupMember } from '@/api/types';

// Re-export types so existing call sites keep working.
export type { WorkspaceGroup };

/** snake_case shape from GET /workspace/groups/ */
interface WorkspaceGroupRaw {
  id: string;
  name: string;
  description: string;
  lead: string | null;
  lead_user_id: string | null;
  member_count: number;
  members: Array<{ id: string; name: string; initials: string; color: string }>;
  projects: Array<{ id: string; name: string; role: number; role_label: string }>;
}

function mapGroup(raw: WorkspaceGroupRaw): WorkspaceGroup {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    lead: raw.lead,
    leadUserId: raw.lead_user_id,
    memberCount: raw.member_count,
    members: raw.members as WorkspaceGroupMember[],
    projects: raw.projects.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      roleLabel: p.role_label,
    })),
  };
}

export function useWorkspaceGroups() {
  return useQuery({
    queryKey: ['workspace-groups'],
    queryFn: async () => {
      // /workspace/groups/ now returns the standard page-number envelope (issue 1355);
      // page through it like every other list endpoint.
      const rows = await fetchAllPages<WorkspaceGroupRaw>('/workspace/groups/');
      return rows.map(mapGroup);
    },
  });
}
