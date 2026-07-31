import { useEffect } from 'react';
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
 *
 * A `409` replace refusal (ADR-0726) also carries a `detail` string, but it is a
 * *question*, not a fault in the file — check {@link seedReplaceConflict} first
 * and only fall through to here when it returns `null`.
 */
export function seedImportErrors(error: unknown): string[] {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (Array.isArray(detail)) return detail as string[];
  if (typeof detail === 'string') return [detail];
  return [];
}

/**
 * What a confirmed re-import would tear down (ADR-0726 §1).
 *
 * Carried by the `409` refusal and by the dry run's `replaces` key, so the same
 * description is shown whether the operator asked first or was stopped. The
 * counts are the point — "a program called Atlas" is not enough information to
 * consent to destroying 812 tasks.
 */
export interface SeedReplaceConflict {
  program_id: string;
  name: string;
  /** The seed's `program.slug`, which collides with this program's `code`. */
  code: string;
  project_count: number;
  task_count: number;
}

/**
 * Extract the replace-confirmation conflict from a failed seed import.
 *
 * Returns the conflict for the two `409` codes the server can raise —
 * `seed_replace_required` (no confirmation was sent) and `seed_replace_mismatch`
 * (the compare-and-swap token named a program that is no longer the one that
 * would be replaced) — and `null` for every other error, so a caller can branch
 * "confirm this" vs. "report this" on one call.
 *
 * Defensive in the same way as {@link seedImportErrors}: the shape is validated
 * rather than asserted, because a proxy or an older server can put anything in
 * the body and a malformed conflict must degrade to the plain error path rather
 * than render a confirmation dialog with blank counts.
 */
export function seedReplaceConflict(error: unknown): SeedReplaceConflict | null {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const { code, conflict } = data as { code?: unknown; conflict?: unknown };
  if (code !== 'seed_replace_required' && code !== 'seed_replace_mismatch') return null;
  if (typeof conflict !== 'object' || conflict === null) return null;
  const c = conflict as Record<string, unknown>;
  if (typeof c.program_id !== 'string' || typeof c.name !== 'string') return null;
  return {
    program_id: c.program_id,
    name: c.name,
    code: typeof c.code === 'string' ? c.code : '',
    project_count: typeof c.project_count === 'number' ? c.project_count : 0,
    task_count: typeof c.task_count === 'number' ? c.task_count : 0,
  };
}

/** Lifecycle of one async seed import (ADR-0726 §5). */
export type ProgramImportJobStatus = 'pending' | 'running' | 'success' | 'failed';

/** Entity counts the job reports once it lands. Empty (`{}`) until then. */
export interface ProgramImportResultSummary {
  projects?: number;
  tasks?: number;
  sprints?: number;
  dependencies?: number;
}

/** GET /programs/{id}/import/jobs/{job_id}/ — one async seed import job. */
export interface ProgramImportJob {
  id: string;
  program: string;
  status: ProgramImportJobStatus;
  filename: string;
  replace: boolean;
  /** The program this import tombstoned, if any — the only durable record of it. */
  replaced_program_id: string | null;
  result_summary: ProgramImportResultSummary;
  /** Reason the job ended `failed`; empty string otherwise. */
  error_detail: string;
  expires_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * `202` envelope from POST /programs/import/ (ADR-0726 §6).
 *
 * `program_id` names a program shell that **already exists** — only its projects
 * and tasks are built in the background — so the client may land the user on it
 * immediately rather than holding them on a spinner.
 */
export interface SeedImportQueued {
  queued: boolean;
  program_id: string;
  import_request_id: string;
  replaced_program_id: string | null;
}

export interface ImportProgramSeedInput {
  file: File;
  /** Confirm replacement of the colliding live program named by the 409. */
  replace?: boolean;
  /**
   * Compare-and-swap token: the server refuses again (`seed_replace_mismatch`)
   * if this is not the program that would actually be replaced. Always prefer
   * sending it over a bare `replace` — a collision set can move between the 409
   * and the confirmation, and a bare `replace=true` would follow it.
   */
  expectedProgramId?: string;
}

/** `pending`/`running` still poll; `success`/`failed` are final. */
export function isTerminalImportStatus(status: ProgramImportJobStatus | undefined): boolean {
  return status === 'success' || status === 'failed';
}

/**
 * POST /api/v1/programs/import/ — queue a program import from a JSON seed (#615, #2574).
 *
 * Sends the file as multipart alongside the two consent fields (ADR-0726 §1) and
 * resolves with the `202` envelope, **not** a `Program`: only the shell is built
 * inside the request. `replace` is omitted rather than sent as `"false"` so the
 * default request is the one the server refuses — withholding consent has to be
 * the shape of *not asking*, not a value that could be mis-serialized to truthy.
 *
 * `timeout: 0` is retained even though the build is now async: the upload itself
 * is still a user-initiated transfer of up to `SEED_MAX_UPLOAD_MB`, and the
 * request also carries the synchronous validate-and-replace half.
 *
 * Invalidates both ``['programs']`` (program list / program tabs) and
 * ``['projects']`` (the sidebar project list, which is NOT a child key of
 * ``['programs']`` so prefix invalidation does not reach it). The program shell
 * exists at this point, so the program lists are already stale; the *projects*
 * only exist when the job lands, which is why
 * {@link useProgramImportStatus} invalidates the same pair again on `success`.
 */
export function useImportProgramSeed(): UseMutationResult<
  SeedImportQueued,
  Error,
  ImportProgramSeedInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, replace, expectedProgramId }: ImportProgramSeedInput) => {
      const form = new FormData();
      form.append('file', file, file.name);
      if (replace) form.append('replace', 'true');
      if (expectedProgramId) form.append('expected_program_id', expectedProgramId);
      const res = await apiClient.post<SeedImportQueued>('/programs/import/', form, {
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
 * GET /api/v1/programs/{programId}/import/jobs/{jobId}/ — poll one seed import.
 *
 * Polls every 1.5 s while the job is `pending`/`running` and stops on
 * `success`/`failed`, mirroring `useCsvImportStatus`. Disabled until both
 * ids exist, so a surface that has not started an import issues no requests.
 *
 * Re-invalidates ``['programs']`` and ``['projects']`` on `success` because that
 * is the moment the imported *projects* exist — the mutation's own invalidation
 * fires against a program shell that is still empty, so without this one the
 * sidebar keeps its pre-import project list until a manual refresh.
 */
export function useProgramImportStatus(
  programId: string | null | undefined,
  jobId: string | null | undefined,
): UseQueryResult<ProgramImportJob, Error> {
  const queryClient = useQueryClient();
  const query = useQuery<ProgramImportJob, Error>({
    queryKey: ['program-import-status', programId, jobId],
    enabled: Boolean(programId) && Boolean(jobId),
    refetchInterval: (q) => (isTerminalImportStatus(q.state.data?.status) ? false : 1500),
    queryFn: async () => {
      const res = await apiClient.get<ProgramImportJob>(
        `/programs/${programId}/import/jobs/${jobId}/`,
      );
      return res.data;
    },
  });

  const status = query.data?.status;
  useEffect(() => {
    if (status !== 'success') return;
    void queryClient.invalidateQueries({ queryKey: ['programs'] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [status, queryClient]);

  return query;
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
