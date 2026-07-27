/**
 * Tests for the org-level resource catalog hooks (#155).
 *
 * The interesting behavior here is entirely in the boundary mapping: the
 * snake_case API payload → the camelCase `OrgResource` domain type, the
 * query-string assembly for the list endpoint, the sparse PATCH body (only
 * keys the caller actually supplied), and the cache reconciliation each
 * mutation performs on success.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

import {
  useResources,
  useResource,
  useCreateResource,
  useUpdateResource,
  useDeactivateResource,
  useRestoreResource,
  type OrgResource,
} from './useResources';

interface ApiSkillFixture {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: 1 | 2 | 3;
}

interface ApiResourceFixture {
  id: string;
  server_version: number;
  name: string;
  email: string;
  job_role: string;
  calendar: string | null;
  max_units: string;
  is_deleted?: boolean;
  skills: ApiSkillFixture[];
}

function apiResource(overrides: Partial<ApiResourceFixture> = {}): ApiResourceFixture {
  return {
    id: 'res-1',
    server_version: 3,
    name: 'Dana Scheduler',
    email: 'dana@example.com',
    job_role: 'Scheduler',
    calendar: 'cal-a',
    max_units: '0.75',
    skills: [],
    ...overrides,
  };
}

function page(results: ApiResourceFixture[]) {
  return { data: { count: results.length, next: null, previous: null, results } };
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  vi.clearAllMocks();
});

describe('useResources', () => {
  it('maps the snake_case payload onto the domain type, including nested skills', async () => {
    getMock.mockResolvedValueOnce(
      page([
        apiResource({
          skills: [
            { id: 'rs-1', resource: 'res-1', skill: 'sk-1', skill_name: 'CPM', proficiency: 3 },
          ],
        }),
      ]),
    );

    const { result } = renderHook(() => useResources(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [r] = result.current.data as OrgResource[];
    expect(r).toMatchObject({
      id: 'res-1',
      name: 'Dana Scheduler',
      email: 'dana@example.com',
      jobRole: 'Scheduler',
      calendarId: 'cal-a',
      maxUnits: 0.75,
      isDeleted: false,
    });
    expect(r.skills).toEqual([
      {
        id: 'rs-1',
        resourceId: 'res-1',
        skillId: 'sk-1',
        skill: { id: 'sk-1', name: 'CPM', normalizedName: '', category: '' },
        proficiency: 3,
      },
    ]);
  });

  it('defaults isDeleted to false when the API omits the flag, and honors it when present', async () => {
    getMock.mockResolvedValueOnce(
      page([
        apiResource({ id: 'a' }),
        apiResource({ id: 'b', is_deleted: true }),
        apiResource({ id: 'c', is_deleted: false }),
      ]),
    );

    const { result } = renderHook(() => useResources({ includeDeleted: true }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect((result.current.data as OrgResource[]).map((r) => r.isDeleted)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('maps a null calendar through as null rather than dropping it', async () => {
    getMock.mockResolvedValueOnce(page([apiResource({ calendar: null })]));

    const { result } = renderHook(() => useResources(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect((result.current.data as OrgResource[])[0].calendarId).toBeNull();
  });

  it('omits both optional query params when called with no arguments', async () => {
    getMock.mockResolvedValueOnce(page([]));

    const { result } = renderHook(() => useResources(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/resources/?page_size=200');
  });

  it('omits the search param when the search string is empty', async () => {
    getMock.mockResolvedValueOnce(page([]));

    const { result } = renderHook(() => useResources({ search: '', includeDeleted: false }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = getMock.mock.calls[0][0] as string;
    expect(url).not.toContain('search=');
    expect(url).not.toContain('include_deleted');
  });

  it('sends both search and include_deleted when supplied', async () => {
    getMock.mockResolvedValueOnce(page([]));

    const { result } = renderHook(
      () => useResources({ search: 'dana scheduler', includeDeleted: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('search=dana+scheduler');
    expect(url).toContain('include_deleted=true');
    expect(url).toContain('page_size=200');
  });

  it('keys the cache by search + includeDeleted so a changed filter refetches', async () => {
    getMock.mockResolvedValue(page([]));

    const { result, rerender } = renderHook(
      ({ search }: { search: string }) => useResources({ search }),
      {
        wrapper,
        initialProps: { search: 'a' },
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ search: 'b' });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(getMock.mock.calls[1][0]).toContain('search=b');
  });

  it('surfaces a request failure as an error state', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useResources(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useResource', () => {
  it('is disabled and never fetches while the id is null', () => {
    const { result } = renderHook(() => useResource(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fetches and maps a single resource once an id is supplied', async () => {
    getMock.mockResolvedValueOnce({ data: apiResource({ id: 'res-9', max_units: '1.0' }) });

    const { result } = renderHook(() => useResource('res-9'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/resources/res-9/');
    expect(result.current.data?.maxUnits).toBe(1);
  });

  it('starts fetching when the id flips from null to a value', async () => {
    getMock.mockResolvedValue({ data: apiResource({ id: 'res-9' }) });

    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useResource(id), {
      wrapper,
      initialProps: { id: null as string | null },
    });
    expect(getMock).not.toHaveBeenCalled();

    rerender({ id: 'res-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

describe('useCreateResource', () => {
  it('fills in empty/default values for every omitted optional field', async () => {
    postMock.mockResolvedValueOnce({ data: apiResource({ id: 'new-1' }) });

    const { result } = renderHook(() => useCreateResource(), { wrapper });
    await result.current.mutateAsync({ name: 'Minimal' });

    expect(postMock).toHaveBeenCalledWith('/resources/', {
      name: 'Minimal',
      email: '',
      job_role: '',
      max_units: 1.0,
    });
  });

  it('passes through every supplied field and returns the mapped resource', async () => {
    postMock.mockResolvedValueOnce({ data: apiResource({ id: 'new-2', max_units: '0.5' }) });

    const { result } = renderHook(() => useCreateResource(), { wrapper });
    const created = await result.current.mutateAsync({
      name: 'Full',
      email: 'full@example.com',
      jobRole: 'PM',
      maxUnits: 0.5,
    });

    expect(postMock).toHaveBeenCalledWith('/resources/', {
      name: 'Full',
      email: 'full@example.com',
      job_role: 'PM',
      max_units: 0.5,
    });
    expect(created).toMatchObject({ id: 'new-2', maxUnits: 0.5 });
  });

  it('invalidates the resource list so the catalog refetches after a create', async () => {
    getMock.mockResolvedValue(page([]));
    postMock.mockResolvedValueOnce({ data: apiResource({ id: 'new-3' }) });

    const { result } = renderHook(() => ({ list: useResources(), create: useCreateResource() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledTimes(1);

    await result.current.create.mutateAsync({ name: 'New' });

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it('does not invalidate when the create request fails', async () => {
    getMock.mockResolvedValue(page([]));
    postMock.mockRejectedValueOnce(new Error('403'));

    const { result } = renderHook(() => ({ list: useResources(), create: useCreateResource() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    await expect(result.current.create.mutateAsync({ name: 'Nope' })).rejects.toThrow('403');
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

describe('useUpdateResource', () => {
  it('sends an empty body when no editable field was supplied', async () => {
    patchMock.mockResolvedValueOnce({ data: apiResource() });

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await result.current.mutateAsync({ id: 'res-1' });

    expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', {});
  });

  it('includes only the fields the caller actually set', async () => {
    patchMock.mockResolvedValueOnce({ data: apiResource() });

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await result.current.mutateAsync({ id: 'res-1', jobRole: 'Lead' });

    expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', { job_role: 'Lead' });
  });

  it('maps every field onto its snake_case counterpart when all are supplied', async () => {
    patchMock.mockResolvedValueOnce({ data: apiResource() });

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await result.current.mutateAsync({
      id: 'res-1',
      name: 'Renamed',
      email: 'r@example.com',
      jobRole: 'Lead',
      maxUnits: 0.25,
      calendarId: 'cal-b',
    });

    expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', {
      name: 'Renamed',
      email: 'r@example.com',
      job_role: 'Lead',
      max_units: 0.25,
      calendar: 'cal-b',
    });
  });

  it('sends an explicit null calendar (clearing the override) rather than omitting it', async () => {
    patchMock.mockResolvedValueOnce({ data: apiResource({ calendar: null }) });

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await result.current.mutateAsync({ id: 'res-1', calendarId: null });

    expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', { calendar: null });
  });

  it('sends falsy-but-defined values (empty string, zero) instead of dropping them', async () => {
    patchMock.mockResolvedValueOnce({ data: apiResource() });

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await result.current.mutateAsync({
      id: 'res-1',
      name: '',
      email: '',
      jobRole: '',
      maxUnits: 0,
    });

    expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', {
      name: '',
      email: '',
      job_role: '',
      max_units: 0,
    });
  });

  it('seeds the single-resource cache with the updated record on success', async () => {
    patchMock.mockResolvedValueOnce({ data: apiResource({ id: 'res-1', name: 'Renamed' }) });

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await result.current.mutateAsync({ id: 'res-1', name: 'Renamed' });

    await waitFor(() =>
      expect(qc.getQueryData<OrgResource>(['org-resource', 'res-1'])?.name).toBe('Renamed'),
    );
  });

  it('leaves the cache untouched when the patch fails', async () => {
    patchMock.mockRejectedValueOnce(new Error('409'));

    const { result } = renderHook(() => useUpdateResource(), { wrapper });
    await expect(result.current.mutateAsync({ id: 'res-1', name: 'x' })).rejects.toThrow('409');

    expect(qc.getQueryData(['org-resource', 'res-1'])).toBeUndefined();
  });
});

describe('useDeactivateResource', () => {
  it('deletes the resource and resolves with its id', async () => {
    deleteMock.mockResolvedValueOnce({ data: null });

    const { result } = renderHook(() => useDeactivateResource(), { wrapper });
    const id = await result.current.mutateAsync('res-7');

    expect(deleteMock).toHaveBeenCalledWith('/resources/res-7/');
    expect(id).toBe('res-7');
  });

  it('refetches the catalog after a successful deactivation', async () => {
    getMock.mockResolvedValue(page([]));
    deleteMock.mockResolvedValueOnce({ data: null });

    const { result } = renderHook(
      () => ({ list: useResources(), deactivate: useDeactivateResource() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    await result.current.deactivate.mutateAsync('res-7');

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it('does not refetch when the delete is rejected', async () => {
    getMock.mockResolvedValue(page([]));
    deleteMock.mockRejectedValueOnce(new Error('forbidden'));

    const { result } = renderHook(
      () => ({ list: useResources(), deactivate: useDeactivateResource() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    await expect(result.current.deactivate.mutateAsync('res-7')).rejects.toThrow('forbidden');
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

describe('useRestoreResource', () => {
  it('posts to the restore action and returns the reactivated resource', async () => {
    postMock.mockResolvedValueOnce({ data: apiResource({ id: 'res-7', is_deleted: false }) });

    const { result } = renderHook(() => useRestoreResource(), { wrapper });
    const restored = await result.current.mutateAsync('res-7');

    expect(postMock).toHaveBeenCalledWith('/resources/res-7/restore/');
    expect(restored.isDeleted).toBe(false);
  });

  it('writes the restored record into the single-resource cache', async () => {
    postMock.mockResolvedValueOnce({ data: apiResource({ id: 'res-7', is_deleted: false }) });

    const { result } = renderHook(() => useRestoreResource(), { wrapper });
    await result.current.mutateAsync('res-7');

    await waitFor(() =>
      expect(qc.getQueryData<OrgResource>(['org-resource', 'res-7'])?.isDeleted).toBe(false),
    );
  });

  it('does not touch the cache when the restore fails', async () => {
    postMock.mockRejectedValueOnce(new Error('gone'));

    const { result } = renderHook(() => useRestoreResource(), { wrapper });
    await expect(result.current.mutateAsync('res-7')).rejects.toThrow('gone');

    expect(qc.getQueryData(['org-resource', 'res-7'])).toBeUndefined();
  });
});
