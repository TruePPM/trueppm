import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get } }));
import { fetchTimesheetAssignments, MAX_PAGES } from './useTimesheetAssignments';

function page(ids: string[], next: string | null) {
  return { data: { results: ids.map((id) => ({ id })), next, previous: null } };
}

beforeEach(() => get.mockReset());

describe('fetchTimesheetAssignments (#4766, #4783)', () => {
  it('walks every page until next is null', async () => {
    get
      .mockResolvedValueOnce(page(['a'], 'http://x/api/v1/me/work/?limit=200&offset=200'))
      .mockResolvedValueOnce(page(['b'], null));
    const out = await fetchTimesheetAssignments();
    expect(out.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(out.partial).toBe(false);
  });

  it('asks the server for open work only, and follows next links as given (#4783)', async () => {
    get
      .mockResolvedValueOnce(page(['a'], 'http://x/api/v1/me/work/?limit=200&offset=200&open=1'))
      .mockResolvedValueOnce(page(['b'], null));
    await fetchTimesheetAssignments();
    expect(get).toHaveBeenNthCalledWith(1, '/me/work/', { params: { limit: 200, open: 1 } });
    // The next link already carries open=1; params are not re-sent on top of it.
    expect(get.mock.calls[1][1]).toEqual({ params: undefined });
  });

  it('stops at a failed later page, flags it partial, and requests nothing further', async () => {
    get
      .mockResolvedValueOnce(page(['a'], 'http://x/api/v1/me/work/?limit=200&offset=200'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(page(['never'], null));
    const out = await fetchTimesheetAssignments();
    expect(out).toEqual({ tasks: [{ id: 'a' }], partial: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('throws when the first page fails, so the page shows its error state', async () => {
    get.mockRejectedValueOnce(new Error('network'));
    await expect(fetchTimesheetAssignments()).rejects.toThrow('network');
  });

  it('caps the walk and flags the result partial when more pages remain', async () => {
    get.mockResolvedValue(page(['a'], 'http://x/api/v1/me/work/?limit=200&offset=200'));
    const out = await fetchTimesheetAssignments();
    expect(get).toHaveBeenCalledTimes(MAX_PAGES);
    expect(out.partial).toBe(true);
  });
});
