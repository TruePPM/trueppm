import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useImportMsProject, useExportMsProject } from './useMsProjectImportExport';

const postMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { post: postMock, get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function xmlFile(): File {
  return new File(['<Project/>'], 'schedule.xml', { type: 'application/xml' });
}

describe('useImportMsProject', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('uploads the file as multipart and returns the import request id', async () => {
    postMock.mockResolvedValueOnce({
      data: { detail: 'Import queued.', import_request_id: 'imp-1' },
    });

    const { result } = renderHook(() => useImportMsProject('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    let returned: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(xmlFile());
    });

    expect(postMock).toHaveBeenCalledWith(
      '/projects/proj-1/import/msproject/',
      expect.any(FormData),
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 },
    );
    const sentForm = postMock.mock.calls[0][1] as FormData;
    expect((sentForm.get('file') as File).name).toBe('schedule.xml');
    expect(returned?.import_request_id).toBe('imp-1');
  });

  it('invalidates the schedule queries on success so the Gantt refetches', async () => {
    postMock.mockResolvedValueOnce({
      data: { detail: 'Import queued.', import_request_id: 'imp-2' },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useImportMsProject('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync(xmlFile());
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
  });

  it('rejects when projectId is null without calling the API', async () => {
    const { result } = renderHook(() => useImportMsProject(null), {
      wrapper: makeWrapper(qc),
    });

    await expect(result.current.mutateAsync(xmlFile())).rejects.toThrow('projectId is required');
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('useExportMsProject', () => {
  let qc: QueryClient;
  // Vitest 4 widens ReturnType<typeof vi.spyOn> to an any-typed MockInstance,
  // which trips no-unsafe-call on clickSpy.mockRestore(); type the spy explicitly.
  let clickSpy: MockInstance<() => void>;

  beforeEach(() => {
    qc = new QueryClient();
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it('requests the XML as a blob and triggers a download with the server filename', async () => {
    getMock.mockResolvedValueOnce({
      data: new Blob(['<Project/>'], { type: 'application/xml' }),
      headers: { 'content-disposition': 'attachment; filename="project-proj-1.xml"' },
    });

    const { result } = renderHook(() => useExportMsProject('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.exportProject();
    });

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/export/msproject.xml', {
      responseType: 'blob',
      timeout: 0,
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isExporting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error message when the export request fails', async () => {
    getMock.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() => useExportMsProject('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.exportProject();
    });

    await waitFor(() => expect(result.current.error).toBe('Export failed. Please try again.'));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('does nothing when projectId is null', async () => {
    const { result } = renderHook(() => useExportMsProject(null), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.exportProject();
    });

    expect(getMock).not.toHaveBeenCalled();
  });
});
