import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
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
  projects: string[];
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
    projects: raw.projects,
  };
}

export function useWorkspaceGroups() {
  return useQuery({
    queryKey: ['workspace-groups'],
    queryFn: async () => {
      const res = await apiClient.get<WorkspaceGroupRaw[]>('/workspace/groups/');
      return res.data.map(mapGroup);
    },
  });
}
