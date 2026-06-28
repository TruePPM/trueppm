import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { fetchAllPages } from '@/api/pagination';
import type { WorkspaceInvite } from '@/api/types';
import { mapInviteToWorkspaceInvite, type WorkspaceInviteRaw } from './useWorkspaceMembers';

export function useWorkspaceInvites() {
  return useQuery({
    queryKey: ['workspace-invites'],
    queryFn: async () => {
      // /workspace/invites/ now returns the standard page-number envelope (issue 1355);
      // page through it like every other list endpoint.
      const rows = await fetchAllPages<WorkspaceInviteRaw>('/workspace/invites/');
      return rows.map(mapInviteToWorkspaceInvite);
    },
  });
}

interface CreateInvitePayload {
  email: string;
  role: number;
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateInvitePayload) => {
      const res = await apiClient.post<WorkspaceInvite>('/workspace/invites/', payload);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-invites'] });
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await apiClient.delete(`/workspace/invites/${inviteId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-invites'] });
    },
  });
}

/**
 * Re-queue one pending/failed invite's email (#969, ADR-0149).
 *
 * The 202 is fire-and-forget — the email sends asynchronously via the outbox
 * drain — so success here means "accepted for re-send", not "delivered". The
 * resend re-issues the token, so any earlier link in the recipient's inbox stops
 * working. Refresh the list so the bumped expiry shows.
 */
export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await apiClient.post(`/workspace/invites/${inviteId}/resend/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-invites'] });
    },
  });
}

/**
 * Re-queue every pending/failed invite in one request (#969, ADR-0149).
 *
 * One server transaction, one throttle bucket — cannot email-bomb. Returns the
 * count actually re-queued (invites already mid-send are skipped).
 */
export function useResendAllInvites() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<{ requeued: number }>('/workspace/invites/resend-all/');
      return res.data.requeued;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-invites'] });
    },
  });
}
