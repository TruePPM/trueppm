import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  isTerminalImportStatus,
  seedImportErrors,
  seedReplaceConflict,
  useExportProgramSeed,
  useExportProjectSeed,
  useLoadSampleProgram,
  useImportProgramSeed,
  useProgramImportStatus,
  useRemoveSampleProgram,
  type ProgramImportJob,
} from './useProgramSeedIo';

describe('seedImportErrors', () => {
  it('extracts the line-level report when detail is a list (#1325)', () => {
    const error = { response: { data: { detail: ['$.program.name: required', '$.x: bad'] } } };
    expect(seedImportErrors(error)).toEqual(['$.program.name: required', '$.x: bad']);
  });

  it('wraps a single-message detail string in a list (#1325)', () => {
    const error = { response: { data: { detail: 'Uploaded file is not valid JSON.' } } };
    expect(seedImportErrors(error)).toEqual(['Uploaded file is not valid JSON.']);
  });

  it('returns an empty list when there is no structured error payload', () => {
    expect(seedImportErrors(new Error('network'))).toEqual([]);
    expect(seedImportErrors(undefined)).toEqual([]);
    expect(seedImportErrors({ response: { data: {} } })).toEqual([]);
  });
});

describe('seedReplaceConflict (#2581, ADR-0726)', () => {
  const CONFLICT = {
    program_id: 'prog-live',
    name: 'Atlas Platform Launch',
    code: 'atlas',
    project_count: 3,
    task_count: 812,
  };

  it('extracts the conflict from a seed_replace_required 409', () => {
    const error = {
      response: { data: { detail: 'Confirm to continue.', code: 'seed_replace_required', conflict: CONFLICT } },
    };
    expect(seedReplaceConflict(error)).toEqual(CONFLICT);
  });

  it('extracts the conflict from a stale compare-and-swap token (seed_replace_mismatch)', () => {
    const error = {
      response: { data: { detail: 'It may have changed.', code: 'seed_replace_mismatch', conflict: CONFLICT } },
    };
    expect(seedReplaceConflict(error)).toEqual(CONFLICT);
  });

  it('returns null for a validation 400, so the caller reports it instead of asking', () => {
    const error = { response: { data: { detail: ['$.program.name: required'] } } };
    expect(seedReplaceConflict(error)).toBeNull();
    expect(seedImportErrors(error)).toEqual(['$.program.name: required']);
  });

  it('returns null for anything without a well-formed conflict object', () => {
    expect(seedReplaceConflict(new Error('network'))).toBeNull();
    expect(seedReplaceConflict(undefined)).toBeNull();
    expect(seedReplaceConflict({ response: { data: { code: 'seed_replace_required' } } })).toBeNull();
    expect(
      seedReplaceConflict({
        response: { data: { code: 'seed_replace_required', conflict: { name: 'Atlas' } } },
      }),
    ).toBeNull();
  });

  it('defaults the counts rather than rendering NaN when the server omits them', () => {
    const error = {
      response: {
        data: { code: 'seed_replace_required', conflict: { program_id: 'p1', name: 'Atlas' } },
      },
    };
    expect(seedReplaceConflict(error)).toEqual({
      program_id: 'p1',
      name: 'Atlas',
      code: '',
      project_count: 0,
      task_count: 0,
    });
  });
});

describe('isTerminalImportStatus', () => {
  it('treats only success and failed as terminal', () => {
    expect(isTerminalImportStatus('pending')).toBe(false);
    expect(isTerminalImportStatus('running')).toBe(false);
    expect(isTerminalImportStatus('success')).toBe(true);
    expect(isTerminalImportStatus('failed')).toBe(true);
    expect(isTerminalImportStatus(undefined)).toBe(false);
  });
});

/** The 202 envelope (ADR-0726 §6) every import now resolves with. */
const QUEUED = {
  queued: true,
  program_id: 'prog-new',
  import_request_id: 'job-1',
  replaced_program_id: null,
};

const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      queued: true,
      program_id: 'prog-new',
      import_request_id: 'job-1',
      replaced_program_id: null,
    },
  }),
);
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, get: getMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function seedFile(name = 'seed.json') {
  return new File(['{}'], name, { type: 'application/json' });
}

function job(overrides: Partial<ProgramImportJob> = {}): ProgramImportJob {
  return {
    id: 'job-1',
    program: 'prog-new',
    status: 'pending',
    filename: 'seed.json',
    replace: false,
    replaced_program_id: null,
    result_summary: {},
    error_detail: '',
    expires_at: null,
    created_at: '2026-07-30T00:00:00Z',
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe('seed-io mutations invalidate the sidebar project list', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  // Regression: the sidebar project list keys on ['projects'], which is NOT a
  // child of ['programs'], so a ['programs']-only invalidation left the newly
  // created sample projects invisible until a manual page refresh.
  it('useLoadSampleProgram invalidates both ["programs"] and ["projects"]', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useLoadSampleProgram(), { wrapper: makeWrapper(qc) });

    result.current.mutate(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/programs/load-sample/', {}, { timeout: 0 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  // Regression (#2402): the server runs the whole fixture import synchronously —
  // a program teardown plus a multi-thousand-round-trip rebuild — which on modest
  // self-hosted hardware can exceed the client's 30 s default. Without the opt-out
  // the *first* action a new evaluator ever takes aborts client-side while the
  // server keeps building the program, leaving them with an error and a program
  // they cannot see.
  it('useLoadSampleProgram opts out of the 30s client timeout', async () => {
    const { result } = renderHook(() => useLoadSampleProgram(), { wrapper: makeWrapper(qc) });

    result.current.mutate('aurora-mobile-app');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith(
      '/programs/load-sample/',
      { sample: 'aurora-mobile-app' },
      { timeout: 0 },
    );
  });

  it('useImportProgramSeed invalidates both ["programs"] and ["projects"]', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useImportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ file: seedFile() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('useImportProgramSeed resolves with the 202 envelope, not a Program (ADR-0726 §6)', async () => {
    const { result } = renderHook(() => useImportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ file: seedFile() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(QUEUED);
  });

  // Withholding consent has to be the shape of *not asking*: an explicit
  // `replace=false` form field is one mis-serialization away from truthy on a
  // server that reads it as a non-empty string.
  it('omits the consent fields entirely on an unconfirmed import', async () => {
    const { result } = renderHook(() => useImportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ file: seedFile() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const form = postMock.mock.calls[0][1] as FormData;
    expect(form.get('replace')).toBeNull();
    expect(form.get('expected_program_id')).toBeNull();
    expect((form.get('file') as File).name).toBe('seed.json');
    expect(postMock.mock.calls[0][0]).toBe('/programs/import/');
    // The upload still opts out of the 30 s client default (#2402).
    expect(postMock.mock.calls[0][2]).toMatchObject({ timeout: 0 });
  });

  it('sends replace + expected_program_id when the user confirms the replacement', async () => {
    const { result } = renderHook(() => useImportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ file: seedFile(), replace: true, expectedProgramId: 'prog-live' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const form = postMock.mock.calls[0][1] as FormData;
    expect(form.get('replace')).toBe('true');
    expect(form.get('expected_program_id')).toBe('prog-live');
  });

  it('useRemoveSampleProgram invalidates both ["programs"] and ["projects"]', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveSampleProgram(), { wrapper: makeWrapper(qc) });

    result.current.mutate('prog-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/remove-sample/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });
});

describe('useProgramImportStatus (ADR-0726 §6)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('stays disabled until both ids exist, so an idle surface issues no requests', () => {
    renderHook(() => useProgramImportStatus(null, null), { wrapper: makeWrapper(qc) });
    renderHook(() => useProgramImportStatus('prog-new', undefined), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('polls the program-scoped job endpoint and surfaces the terminal summary', async () => {
    getMock.mockResolvedValue({
      data: job({ status: 'success', result_summary: { projects: 3, tasks: 812 } }),
    });
    const { result } = renderHook(() => useProgramImportStatus('prog-new', 'job-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.status).toBe('success'));
    expect(getMock).toHaveBeenCalledWith('/programs/prog-new/import/jobs/job-1/');
    expect(result.current.data?.result_summary).toEqual({ projects: 3, tasks: 812 });
  });

  it('surfaces error_detail when the background build fails', async () => {
    getMock.mockResolvedValue({
      data: job({ status: 'failed', error_detail: 'Seed references an unknown resource.' }),
    });
    const { result } = renderHook(() => useProgramImportStatus('prog-new', 'job-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.status).toBe('failed'));
    expect(result.current.data?.error_detail).toBe('Seed references an unknown resource.');
  });

  // The mutation's own invalidation fires against a program shell that is still
  // empty — the projects only exist when the job lands, so without this second
  // pass the sidebar keeps its pre-import list until a manual refresh.
  it('re-invalidates ["programs"] and ["projects"] once the job reaches success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    getMock.mockResolvedValue({ data: job({ status: 'success' }) });
    const { result } = renderHook(() => useProgramImportStatus('prog-new', 'job-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.status).toBe('success'));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('does not invalidate on a non-terminal poll', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    getMock.mockResolvedValue({ data: job({ status: 'running' }) });
    const { result } = renderHook(() => useProgramImportStatus('prog-new', 'job-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.status).toBe('running'));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useExportProgramSeed download flow', () => {
  let qc: QueryClient;
  let clickSpy: MockInstance<() => void>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: new Blob(['{}'], { type: 'application/json' }) });
    // jsdom implements neither object-URL helper, so stub them on the URL global.
    createObjectURL = vi.fn().mockReturnValue('blob:fake');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => clickSpy.mockRestore());

  it('fetches the program as a blob and triggers a download named by code', async () => {
    const { result } = renderHook(() => useExportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ programId: 'prog-1', code: 'ATLAS' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/programs/prog-1/export/', {
      responseType: 'blob',
      timeout: 0,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('falls back to the program id as the filename when code is absent', async () => {
    const downloads: string[] = [];
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const { result } = renderHook(() => useExportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ programId: 'prog-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(downloads).toEqual(['prog-9.json']);
  });
});

describe('useExportProjectSeed download flow (#967)', () => {
  let qc: QueryClient;
  let clickSpy: MockInstance<() => void>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: new Blob(['{}'], { type: 'application/json' }) });
    createObjectURL = vi.fn().mockReturnValue('blob:fake');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => clickSpy.mockRestore());

  it('fetches the project as a blob and triggers a download named by code', async () => {
    const { result } = renderHook(() => useExportProjectSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'proj-1', code: 'APOLLO' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/export/', {
      responseType: 'blob',
      timeout: 0,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('falls back to the project id as the filename when code is absent', async () => {
    const downloads: string[] = [];
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const { result } = renderHook(() => useExportProjectSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'proj-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(downloads).toEqual(['proj-9.json']);
  });

  it('rejects when projectId is missing without calling the API', async () => {
    const { result } = renderHook(() => useExportProjectSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: undefined });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(getMock).not.toHaveBeenCalled();
  });
});
