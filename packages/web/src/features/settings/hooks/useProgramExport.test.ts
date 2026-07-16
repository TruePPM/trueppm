import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  downloadProgramExport,
  useProgramExportJob,
  useStartProgramExport,
  type ProgramExportJob,
} from './useProgramExport';

const postMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { post: postMock, get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function rawJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    status: 'pending',
    file_size: null,
    error_detail: '',
    expires_at: null,
    created_at: '2026-07-14T00:00:00Z',
    started_at: null,
    completed_at: null,
    download_url: null,
    ...overrides,
  };
}

describe('useStartProgramExport', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs to the program export endpoint and maps snake_case to camelCase', async () => {
    postMock.mockResolvedValueOnce({ data: rawJob() });
    const { result } = renderHook(() => useStartProgramExport('prog-1'), {
      wrapper: makeWrapper(qc),
    });

    let job: ProgramExportJob | undefined;
    await act(async () => {
      job = await result.current.mutateAsync(undefined as void);
    });

    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/export/');
    expect(job?.id).toBe('job-1');
    expect(job?.status).toBe('pending');
    expect(job?.downloadUrl).toBeNull();
  });
});

describe('useProgramExportJob', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('is disabled (does not fetch) when jobId is null', () => {
    renderHook(() => useProgramExportJob('prog-1', null), { wrapper: makeWrapper(qc) });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('polls the job endpoint and surfaces the download url when ready', async () => {
    getMock.mockResolvedValueOnce({
      data: rawJob({
        status: 'success',
        file_size: 4096,
        download_url: '/api/v1/programs/prog-1/export/jobs/job-1/download/',
      }),
    });
    const { result } = renderHook(() => useProgramExportJob('prog-1', 'job-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.status).toBe('success'));
    expect(getMock).toHaveBeenCalledWith('/programs/prog-1/export/jobs/job-1/');
    expect(result.current.data?.fileSize).toBe(4096);
    expect(result.current.data?.downloadUrl).toBe(
      '/api/v1/programs/prog-1/export/jobs/job-1/download/',
    );
  });
});

describe('downloadProgramExport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the authenticated blob and triggers a code-named download', async () => {
    const blob = new Blob(['gz'], { type: 'application/gzip' });
    getMock.mockResolvedValueOnce({ data: blob });
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const job = { id: 'job-1' } as ProgramExportJob;
    await downloadProgramExport('prog-1', job, 'atlas');

    expect(getMock).toHaveBeenCalledWith('/programs/prog-1/export/jobs/job-1/download/', {
      responseType: 'blob',
      timeout: 0,
    });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
