import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useTemplateDivergence, type TemplateDivergence } from './useProjectTemplates';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: getMock } }));

const DIGEST: TemplateDivergence = {
  project: 'p1',
  adopted: true,
  application: 'app-1',
  application_count: 1,
  template: 'tpl-1',
  template_name: 'Delivery skeleton',
  template_version: 3,
  template_available: true,
  applied_at: '2026-08-12T09:00:00Z',
  applied_by_name: 'Kelly',
  seeded_row_count: 42,
  unchanged: 30,
  adapted: 8,
  removed: 4,
  added: 11,
};

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  getMock.mockReset();
});

describe('useTemplateDivergence', () => {
  it('reads the one project-scoped route, with no audience parameter', async () => {
    // The absence of a params argument is the assertion. The symmetry requirement
    // (#2971) is kept by there being nothing to vary the report by — if a `for=` or
    // `audience=` param ever appears here, the two halves can drift and this fails.
    getMock.mockResolvedValueOnce({ data: DIGEST });
    const { result } = renderHook(() => useTemplateDivergence('p1'), {
      wrapper: makeWrapper(client()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/p1/template-divergence/');
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(DIGEST);
  });

  it('does not fetch without a project id', () => {
    renderHook(() => useTemplateDivergence(null), { wrapper: makeWrapper(client()) });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed read as an error rather than an empty digest', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useTemplateDivergence('p1'), {
      wrapper: makeWrapper(client()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keys the cache per project so two projects never share a digest', async () => {
    getMock.mockResolvedValue({ data: DIGEST });
    const qc = client();
    const wrapper = makeWrapper(qc);

    const a = renderHook(() => useTemplateDivergence('p1'), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    const b = renderHook(() => useTemplateDivergence('p2'), { wrapper });
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/p2/template-divergence/');
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
