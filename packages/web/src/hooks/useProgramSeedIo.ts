import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Program } from '@/api/types';

/**
 * Client-side soft cap for a native TruePPM seed upload, in MB.
 *
 * Mirrors the server's authoritative `SEED_MAX_UPLOAD_MB` (default 5 MB), which
 * `POST /programs/import/` enforces. The dropzone uses this only to reject an
 * over-size file early with a friendly message; the server remains the source of
 * truth. Deliberately smaller than the MS Project cap (50 MB) — a JSON seed is
 * text and compresses far denser than a binary schedule file.
 */
export const SEED_MAX_UPLOAD_MB = 5;

export interface SampleInfo {
  key: string;
  title: string;
  description: string;
  /** Name the download is served under. */
  filename: string;
  /** False when the registry names a fixture this installation does not have. */
  available: boolean;
  size_bytes: number | null;
  /**
   * SHA-256 of the exact bytes the download serves. Proves transport integrity —
   * that you received the file this instance ships — not provenance.
   */
  sha256: string | null;
  schema_version: string | null;
  /** Null when the fixture is present but could not be parsed — it stays downloadable. */
  project_count: number | null;
  task_count: number | null;
  resource_count: number | null;
  /** Server-built. Link this rather than assembling a URL from `key`. */
  download_url: string;
}

/**
 * GET /api/v1/programs/samples/ — list bundled demo samples (#375, #2490).
 *
 * One fetch feeds both consumers: the loader picker (which shows each sample's
 * scale inline) and the Demo data page (which adds provenance and downloads).
 * Sharing the query means the two surfaces can never disagree about what is
 * bundled — and the picker's counts cost no extra request.
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

export type SampleCatalogStatus = 'loading' | 'ready' | 'error';

export interface SampleCatalog {
  samples: SampleInfo[];
  status: SampleCatalogStatus;
  retry: () => void;
}

/**
 * The sample catalog, narrowed to what the Demo data page renders (#2490).
 *
 * Wraps {@link useSamples} in the three-state shape the listing's states map to
 * directly — loading skeletons, rows, or an error with a working Retry — so the
 * component never reasons about TanStack Query's flag combinations. An empty
 * `samples` array with `status: 'ready'` is a real, reachable state: a build
 * that ships without bundled fixtures.
 */
export function useSampleCatalog(): SampleCatalog {
  const query = useSamples();
  const status: SampleCatalogStatus = query.isPending
    ? 'loading'
    : query.isError
      ? 'error'
      : 'ready';
  return {
    samples: query.data ?? [],
    status,
    retry: () => void query.refetch(),
  };
}

/**
 * Extract the server's line-level validation report from a failed import.
 *
 * The import endpoint (#615) returns the standard ``{ "detail": ... }`` envelope
 * (issue 1325) with a 400 when a seed fails schema or referential validation. For the
 * line-level report `detail` is an array of messages; the single-message failures
 * (file too large, not JSON) use a plain string. Normalize both to a string list
 * so the caller can render them verbatim and the user can fix the file.
 */
export function seedImportErrors(error: unknown): string[] {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (Array.isArray(detail)) return detail as string[];
  if (typeof detail === 'string') return [detail];
  return [];
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
        timeout: 0,
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
 * Response envelope for POST /programs/load-sample/ (issue 1054).
 *
 * `landing_project_id` is the project whose first open sprint was assigned to
 * the caller — the board a contributor should land on so their work is visible.
 * `null` when the sample has no open sprint (e.g. the waterfall-only sample), in
 * which case the caller falls back to the program overview. `sample_key` echoes
 * the loaded sample so the client renders the matching "Start exploring"
 * guidance without guessing the server default.
 */
export interface LoadSampleResult {
  program: Program;
  landing_project_id: string | null;
  sample_key: string;
}

/**
 * POST /api/v1/programs/load-sample/ — load the bundled demo program (#375, issue 1054).
 *
 * The "Load demo data" empty-state action. Creates the sample (owned by the
 * caller), assigns the caller the first open sprint's tasks server-side, and
 * invalidates both ``['programs']`` and ``['projects']`` — the sample creates a
 * program *and* its projects, and the sidebar project list keys on
 * ``['projects']`` (not a child of ``['programs']``), so without the second
 * invalidation the new projects only appear after a manual page refresh. The
 * per-program projects tab (``['programs', id, 'projects']``) is already covered
 * by the prefix-matching ``['programs']`` invalidation. Returns the
 * {@link LoadSampleResult} envelope so the caller knows where to land the user
 * and which sample's guidance to show.
 */
export function useLoadSampleProgram(): UseMutationResult<
  LoadSampleResult,
  Error,
  string | undefined
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sample: string | undefined) => {
      const res = await apiClient.post<LoadSampleResult>(
        '/programs/load-sample/',
        sample ? { sample } : {},
        // Opt out of the client's 30 s default (#2402). The server runs the
        // whole fixture import synchronously — a program teardown plus a
        // multi-thousand-round-trip rebuild — so this is a long user-initiated
        // import in exactly the sense client.ts carves out for MSP import and
        // export bundles. On modest self-hosted hardware it can exceed 30 s, and
        // timing it out would abort the *first* thing a new evaluator ever
        // clicks while the server keeps building the program anyway. The
        // mutation's own pending state is the progress affordance.
        { timeout: 0 },
      );
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
        timeout: 0,
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

export interface ExportProjectInput {
  /** May be null/undefined while the route param resolves; guarded at call time. */
  projectId: string | null | undefined;
  /** Project code/slug — used as the download filename when present. */
  code?: string | null;
}

/**
 * GET /api/v1/projects/{id}/export/ — download a single project as a JSON seed
 * file (#967). The project-grain counterpart to {@link useExportProgramSeed};
 * the exported file wraps the project in a synthesized single-project program
 * and round-trips back through the importer.
 */
export function useExportProjectSeed(): UseMutationResult<void, Error, ExportProjectInput> {
  return useMutation({
    mutationFn: async ({ projectId, code }) => {
      if (!projectId) throw new Error('projectId is required');
      const res = await apiClient.get(`/projects/${projectId}/export/`, {
        responseType: 'blob',
        timeout: 0,
      });
      const url = URL.createObjectURL(res.data as Blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${code || projectId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
  });
}
