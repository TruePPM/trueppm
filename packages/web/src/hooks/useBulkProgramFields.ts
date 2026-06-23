import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/api/client';
import type { BulkFieldsResult, BulkFieldValue } from '@/hooks/useBulkProjectFields';

/**
 * `POST /api/v1/programs/bulk-fields/` — set one inherited/policy field
 * (methodology, iteration_label, risk_slip_propagation, risk_escalation_days) on a
 * selection of the workspace's programs in a single all-or-nothing call (ADR-0161,
 * issue 1233 / 1283). This is the **workspace scope** of the bulk matrix: the server
 * gates it at IsWorkspaceAdmin (org-level authority — Program has no workspace FK, the
 * workspace is the singleton) and is the authority on the row cap (200) and field
 * allowlist. The hook just invalidates the programs list so the cells repaint from truth.
 */
export function useBulkProgramFields() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { ids: string[]; field: string; value: BulkFieldValue }) => {
      const res = await apiClient.post<BulkFieldsResult>('/programs/bulk-fields/', {
        ids: vars.ids,
        fields: { [vars.field]: vars.value },
      });
      return res.data;
    },
    onSuccess: () => {
      // usePrograms keys its list on ['programs'].
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });
}
