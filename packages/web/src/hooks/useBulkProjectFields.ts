import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/api/client';

/** Response envelope of the bulk-fields endpoints (ADR-0161, issue 1233). */
export interface BulkFieldsResult {
  updated: { id: string; server_version: number }[];
  fields: string[];
}

/** A single inherited-field value the matrix can set. `null` clears the override
 * (the row inherits again) — only valid for genuine null-sentinel fields. */
export type BulkFieldValue = string | number | null;

/**
 * `POST /api/v1/programs/{id}/bulk-project-fields/` — set one inherited field
 * (methodology, iteration_label) on a selection of a program's projects in a single
 * all-or-nothing call (ADR-0161, issue 1233). The server bumps `server_version` + writes
 * history per row and is the authority on the row cap (200) and field allowlist; this
 * hook just invalidates the program's project list so the cells repaint from truth.
 */
export function useBulkProjectFields(programId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { ids: string[]; field: string; value: BulkFieldValue }) => {
      const res = await apiClient.post<BulkFieldsResult>(
        `/programs/${programId}/bulk-project-fields/`,
        { ids: vars.ids, fields: { [vars.field]: vars.value } },
      );
      return res.data;
    },
    onSuccess: () => {
      // useProgramProjects keys its list on ['programs', id, 'projects'].
      void queryClient.invalidateQueries({ queryKey: ['programs', programId, 'projects'] });
    },
  });
}
