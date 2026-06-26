import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('./client', () => ({
  apiClient: { get: getMock },
}));

import { fetchAllPages } from './pagination';

describe('fetchAllPages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the rows of a single page when next is null', async () => {
    getMock.mockResolvedValueOnce({ data: { results: [{ id: 'a' }, { id: 'b' }], next: null } });

    const rows = await fetchAllPages<{ id: string }>('/workspace/members/');

    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('follows next across pages and accumulates rows in order', async () => {
    getMock
      .mockResolvedValueOnce({
        data: { results: [{ id: 'a' }], next: 'http://host/api/v1/workspace/members/?cursor=p2' },
      })
      .mockResolvedValueOnce({
        data: { results: [{ id: 'b' }], next: 'https://host:8000/api/v1/workspace/members/?cursor=p3' },
      })
      .mockResolvedValueOnce({ data: { results: [{ id: 'c' }], next: null } });

    const rows = await fetchAllPages<{ id: string }>('/workspace/members/');

    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('strips host + /api/v1 from next so axios does not double-prefix the baseURL', async () => {
    getMock
      .mockResolvedValueOnce({
        data: { results: [], next: 'http://host/api/v1/teams/t1/members/?cursor=abc' },
      })
      .mockResolvedValueOnce({ data: { results: [], next: null } });

    await fetchAllPages('/teams/t1/members/');

    // Second call uses the baseURL-relative remainder, not the absolute URL.
    expect(getMock.mock.calls[1][0]).toBe('/teams/t1/members/?cursor=abc');
  });

  it('sends params on the first page only', async () => {
    getMock
      .mockResolvedValueOnce({
        data: { results: [], next: 'http://host/api/v1/items/?page=2' },
      })
      .mockResolvedValueOnce({ data: { results: [], next: null } });

    await fetchAllPages('/items/', { project: 'p1' });

    expect(getMock.mock.calls[0][1]).toEqual({ params: { project: 'p1' } });
    expect(getMock.mock.calls[1][1]).toBeUndefined();
  });
});
