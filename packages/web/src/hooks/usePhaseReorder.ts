/**
 * Phase reorder hook — PATCH /projects/{pk}/phases/reorder/
 *
 * Accepts an ordered list of phase entries (id + serverVersion) and sends the
 * ADR-0046 body shape.  Returns a 409 conflict error as PhaseVersionConflictError
 * so callers can roll back optimistic order state.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

export interface PhaseEntry {
  id: string;
  serverVersion: number;
}

export class PhaseVersionConflictError extends Error {
  constructor() {
    super('Phase version conflict — another participant updated the order. Refreshing.');
    this.name = 'PhaseVersionConflictError';
  }
}

export function usePhaseReorder(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (phases: PhaseEntry[]) => {
      try {
        await apiClient.patch(`/projects/${projectId}/phases/reorder/`, {
          phases: phases.map((p) => ({ id: p.id, server_version: p.serverVersion })),
        });
      } catch (err) {
        const axiosErr = err as AxiosError;
        if (axiosErr?.response?.status === 409) {
          throw new PhaseVersionConflictError();
        }
        throw err;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
    onError: (err) => {
      // On version conflict invalidate immediately so the UI snaps to server order.
      if (err instanceof PhaseVersionConflictError) {
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      }
    },
  });
}
