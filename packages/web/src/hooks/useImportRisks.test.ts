/**
 * Tests for useImportRisks (#223, ADR-0043 addendum) — the risk CSV import
 * mutation. Covers the multipart POST shape, the cache invalidation contract
 * (refetch only when something landed), and the guard against a missing project.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

import { useImportRisks } from './useImportRisks';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function csvFile(name = 'risks.csv'): File {
  return new File(['Title\nServer outage'], name, { type: 'text/csv' });
}

describe('useImportRisks', () => {
  let qc: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    vi.clearAllMocks();
  });

  it('POSTs multipart/form-data with the file and invalidates the risks cache', async () => {
    postMock.mockResolvedValueOnce({
      data: { imported: 1, skipped: 0, errors: [], warnings: [] },
    });

    const { result } = renderHook(() => useImportRisks('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate(csvFile());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body, config] = postMock.mock.calls[0] as [
      string,
      FormData,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('/projects/p1/risks/import/');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBeInstanceOf(File);
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });

    // Something landed → the register refetches.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['risks', 'p1'] });
    expect(result.current.data).toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
      warnings: [],
    });
  });

  it('does NOT invalidate when zero rows imported (all-invalid file)', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        imported: 0,
        skipped: 2,
        errors: [
          { row: 2, field: 'Title', message: 'Title is required.' },
          { row: 3, field: 'Title', message: 'Title is required.' },
        ],
        warnings: [],
      },
    });

    const { result } = renderHook(() => useImportRisks('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate(csvFile());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.skipped).toBe(2);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('surfaces the server error and never invalidates', async () => {
    postMock.mockRejectedValueOnce(new Error('413'));

    const { result } = renderHook(() => useImportRisks('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate(csvFile());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('rejects without a projectId and never hits the network', async () => {
    const { result } = renderHook(() => useImportRisks(null), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate(csvFile());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(postMock).not.toHaveBeenCalled();
  });
});
