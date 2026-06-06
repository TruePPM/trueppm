import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Program } from '@/api/types';

/**
 * Extract the server's line-level validation report from a failed import.
 *
 * The import endpoint (#615) returns ``{ "errors": [...] }`` with a 400 when a
 * seed fails schema or referential validation; surface those verbatim so the
 * user can fix the file.
 */
export function seedImportErrors(error: unknown): string[] {
  const data = (error as { response?: { data?: { errors?: unknown } } })?.response?.data;
  return Array.isArray(data?.errors) ? (data.errors as string[]) : [];
}

/**
 * POST /api/v1/programs/import/ — import a program from a JSON seed file (#615).
 *
 * Sends the file as multipart. On success the new program is owned by the
 * caller; invalidate ``['programs']`` so the list and sidebar refetch.
 */
export function useImportProgramSeed(): UseMutationResult<Program, Error, File> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await apiClient.post<Program>('/programs/import/', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });
}

export interface ExportProgramInput {
  programId: string;
  /** Program code/slug — used as the download filename when present. */
  code?: string | null;
}

/**
 * GET /api/v1/programs/{id}/export/ — download a program as a JSON seed file (#616).
 *
 * Fetches the response as a blob and triggers a browser download. The exported
 * file round-trips back through the importer.
 */
export function useExportProgramSeed(): UseMutationResult<void, Error, ExportProgramInput> {
  return useMutation({
    mutationFn: async ({ programId, code }) => {
      const res = await apiClient.get(`/programs/${programId}/export/`, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data as Blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${code || programId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
  });
}
