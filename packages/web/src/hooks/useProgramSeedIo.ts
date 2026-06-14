import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Program } from '@/api/types';

export interface SampleInfo {
  key: string;
  title: string;
  description: string;
}

/**
 * GET /api/v1/programs/samples/ — list bundled demo samples for the picker (#375).
 */
export function useSamples(): UseQueryResult<SampleInfo[], Error> {
  return useQuery({
    queryKey: ['program-samples'],
    queryFn: async () => {
      const res = await apiClient.get<SampleInfo[]>('/programs/samples/');
      return res.data;
    },
    staleTime: 60 * 60 * 1000,
  });
}

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
 * caller; invalidate both ``['programs']`` (program list / program tabs) and
 * ``['projects']`` (the sidebar project list, which is NOT a child key of
 * ``['programs']`` so prefix invalidation does not reach it) so the import's
 * new projects appear without a manual page refresh.
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
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/**
 * POST /api/v1/programs/load-sample/ — load the bundled demo program (#375).
 *
 * The "Load demo data" empty-state action. Creates the Atlas hybrid-large
 * sample (owned by the caller) and invalidates both ``['programs']`` and
 * ``['projects']`` — the sample creates a program *and* its projects, and the
 * sidebar project list keys on ``['projects']`` (not a child of ``['programs']``),
 * so without the second invalidation the new projects only appear after a manual
 * page refresh. The per-program projects tab (``['programs', id, 'projects']``)
 * is already covered by the prefix-matching ``['programs']`` invalidation.
 */
export function useLoadSampleProgram(): UseMutationResult<Program, Error, string | undefined> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sample: string | undefined) => {
      const res = await apiClient.post<Program>('/programs/load-sample/', sample ? { sample } : {});
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/**
 * POST /api/v1/programs/{id}/remove-sample/ — tear down sample data (#375).
 *
 * The "Remove sample data" banner action. Owner-only server-side; refuses to
 * delete a non-sample program. Tears down the sample's projects too, so it
 * invalidates ``['projects']`` alongside ``['programs']`` — otherwise the
 * removed projects linger in the sidebar until a manual refresh.
 */
export function useRemoveSampleProgram(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (programId: string) => {
      await apiClient.post(`/programs/${programId}/remove-sample/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
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
