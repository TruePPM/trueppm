import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AgentAuditVerify, AgentDetail, AgentListResponse, AgentScope } from '@/api/types';

/**
 * Cache keys for the workspace Agents page (#4814, #4757). Every control-plane
 * write invalidates the whole `['agents']` family, because a pause or scope edit
 * changes both the list row and the detail panel, and appends a row to the chain
 * the verified line counts.
 */
export const agentKeys = {
  all: ['agents'] as const,
  list: (program?: string) => ['agents', 'list', program ?? null] as const,
  detail: (id: string) => ['agents', 'detail', id] as const,
  verify: ['agents', 'audit-verify'] as const,
};

/** Agents the caller can see, filtered server-side by project membership. */
export function useAgents(program?: string) {
  return useQuery({
    queryKey: agentKeys.list(program),
    queryFn: async () => {
      const res = await apiClient.get<AgentListResponse>('/agents/', {
        params: program ? { program } : undefined,
      });
      return res.data;
    },
  });
}

/** One agent with its recent actions; disabled until an agent is selected. */
export function useAgent(id: string | null) {
  return useQuery({
    queryKey: agentKeys.detail(id ?? ''),
    queryFn: async () => (await apiClient.get<AgentDetail>(`/agents/${id}/`)).data,
    enabled: !!id,
  });
}

/** The "Action log verified" line. The server caches the chain walk. */
export function useAgentAuditVerify() {
  return useQuery({
    queryKey: agentKeys.verify,
    queryFn: async () => (await apiClient.get<AgentAuditVerify>('/agents/audit-verify/')).data,
  });
}

export type AgentControlAction = 'pause' | 'resume' | 'revoke';

/** Pause, resume or revoke. The server decides; the UI only reflects the result. */
export function useAgentControl(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, reason }: { action: AgentControlAction; reason?: string }) =>
      (await apiClient.post<AgentDetail>(`/agents/${id}/${action}/`, { reason: reason ?? '' }))
        .data,
    onSuccess: (data) => {
      qc.setQueryData(agentKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

/** Replace the grant for the areas named. `write` is refused by the server in 0.5. */
export function useEditAgentScope(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ scope, reason }: { scope: AgentScope; reason?: string }) =>
      (
        await apiClient.patch<AgentDetail>(`/agents/${id}/scope/`, {
          scope,
          reason: reason ?? '',
        })
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(agentKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}
