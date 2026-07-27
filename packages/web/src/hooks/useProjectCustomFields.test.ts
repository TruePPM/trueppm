/**
 * Coverage for the custom-field CRUD hook (#521, #2143) — issue #2459.
 *
 * The behaviour under test is the wire translation and the cache maintenance:
 * snake_case <-> camelCase mapping with tolerant defaults for a pre-#2143 API,
 * the `enabled` guard when no project is selected, the sparse PATCH body that
 * must distinguish "absent" from "explicitly false/zero", and the two
 * `setQueryData` writers that must no-op rather than throw when nothing is
 * cached yet.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useProjectCustomFields,
  type CustomFieldOption,
  type ProjectCustomField,
} from './useProjectCustomFields';

interface ApiRow {
  id: string;
  name: string;
  field_type: string;
  required: boolean;
  options?: CustomFieldOption[] | null;
  order: number;
  show_on_card?: boolean;
  server_version: number;
}

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

function row(overrides: Partial<ApiRow> & Pick<ApiRow, 'id'>): ApiRow {
  return {
    name: `Field ${overrides.id}`,
    field_type: 'TEXT',
    required: false,
    options: [],
    order: 0,
    show_on_card: false,
    server_version: 1,
    ...overrides,
  };
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

function renderFields(projectId: string | null | undefined) {
  return renderHook(() => useProjectCustomFields(projectId), { wrapper });
}

beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.clearAllMocks();
});

describe('useProjectCustomFields — query gating', () => {
  it('does not fetch and reports an empty list when projectId is null', () => {
    const { result } = renderFields(null);
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.fields).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when projectId is undefined', () => {
    const { result } = renderFields(undefined);
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.fields).toEqual([]);
  });

  it('does not fetch when projectId is the empty string', () => {
    const { result } = renderFields('');
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.fields).toEqual([]);
  });

  it('fetches the project scoped collection when a projectId is present', async () => {
    getMock.mockResolvedValueOnce({ data: [] });
    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/fields/');
    expect(result.current.fields).toEqual([]);
  });
});

describe('useProjectCustomFields — read mapping', () => {
  it('maps the snake_case wire row onto the camelCase shape', async () => {
    const options: CustomFieldOption[] = [
      { value: 'red', label: 'Red', color: '#f00' },
      { value: 'blue', label: 'Blue', color: null },
    ];
    getMock.mockResolvedValueOnce({
      data: [
        row({
          id: 'f1',
          name: 'Severity',
          field_type: 'SINGLE_SELECT',
          required: true,
          options,
          order: 3,
          show_on_card: true,
          server_version: 7,
        }),
      ],
    });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    expect(result.current.fields[0]).toEqual<ProjectCustomField>({
      id: 'f1',
      name: 'Severity',
      fieldType: 'SINGLE_SELECT',
      required: true,
      options,
      order: 3,
      showOnCard: true,
      serverVersion: 7,
    });
  });

  it('substitutes an empty option list when the API sends null options', async () => {
    getMock.mockResolvedValueOnce({ data: [row({ id: 'f1', options: null })] });
    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));
    expect(result.current.fields[0].options).toEqual([]);
  });

  it('defaults showOnCard to false for a pre-#2143 API that omits show_on_card', async () => {
    const legacy = row({ id: 'f1' });
    delete legacy.show_on_card;
    getMock.mockResolvedValueOnce({ data: [legacy] });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));
    expect(result.current.fields[0].showOnCard).toBe(false);
  });

  it('surfaces a failed fetch as an error with an empty field list', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.fields).toEqual([]);
  });
});

describe('useProjectCustomFields — create', () => {
  it('fills in required/options/showOnCard defaults when the caller omits them', async () => {
    getMock.mockResolvedValue({ data: [] });
    postMock.mockResolvedValueOnce({ data: row({ id: 'new' }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    result.current.create.mutate({ name: 'Notes', fieldType: 'TEXT' });
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/p1/fields/', {
      name: 'Notes',
      field_type: 'TEXT',
      required: false,
      options: [],
      show_on_card: false,
    });
  });

  it('sends the caller supplied required/options/showOnCard when they are given', async () => {
    getMock.mockResolvedValue({ data: [] });
    const options: CustomFieldOption[] = [{ value: 'a', label: 'A' }];
    postMock.mockResolvedValueOnce({
      data: row({ id: 'new', required: true, options, show_on_card: true }),
    });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    result.current.create.mutate({
      name: 'Team',
      fieldType: 'SINGLE_SELECT',
      required: true,
      options,
      showOnCard: true,
    });
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/p1/fields/', {
      name: 'Team',
      field_type: 'SINGLE_SELECT',
      required: true,
      options,
      show_on_card: true,
    });
    expect(result.current.create.data?.showOnCard).toBe(true);
  });

  it('refetches the collection after a successful create', async () => {
    getMock.mockResolvedValueOnce({ data: [] });
    getMock.mockResolvedValueOnce({ data: [row({ id: 'new', name: 'Notes' })] });
    postMock.mockResolvedValueOnce({ data: row({ id: 'new', name: 'Notes' }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    result.current.create.mutate({ name: 'Notes', fieldType: 'TEXT' });
    await waitFor(() => expect(result.current.fields.map((f) => f.id)).toEqual(['new']));
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('reports a failed create without disturbing the cached list', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'f1' })] });
    postMock.mockRejectedValueOnce(new Error('409'));

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.create.mutate({ name: 'Dup', fieldType: 'TEXT' });
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    expect(result.current.fields.map((f) => f.id)).toEqual(['f1']);
  });
});

describe('useProjectCustomFields — update', () => {
  it('sends an empty body when the payload carries no keys', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'f1' })] });
    patchMock.mockResolvedValueOnce({ data: row({ id: 'f1' }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.update.mutate({ id: 'f1', payload: {} });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

    expect(patchMock).toHaveBeenCalledWith('/projects/p1/fields/f1/', {});
  });

  it('sends only the keys the caller actually set', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'f1' })] });
    patchMock.mockResolvedValueOnce({ data: row({ id: 'f1', name: 'Renamed' }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.update.mutate({ id: 'f1', payload: { name: 'Renamed' } });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

    expect(patchMock).toHaveBeenCalledWith('/projects/p1/fields/f1/', { name: 'Renamed' });
  });

  it('sends every key, snake-cased, when the caller sets all of them', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'f1' })] });
    const options: CustomFieldOption[] = [{ value: 'x', label: 'X' }];
    patchMock.mockResolvedValueOnce({
      data: row({ id: 'f1', name: 'All', required: true, options, order: 5, show_on_card: true }),
    });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.update.mutate({
      id: 'f1',
      payload: { name: 'All', required: true, options, order: 5, showOnCard: true },
    });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

    expect(patchMock).toHaveBeenCalledWith('/projects/p1/fields/f1/', {
      name: 'All',
      required: true,
      options,
      order: 5,
      show_on_card: true,
    });
  });

  it('sends explicitly falsy values rather than treating them as absent', async () => {
    // `required: false`, `order: 0` and `showOnCard: false` are the values a
    // user clears a field back to — dropping them would silently no-op the save.
    getMock.mockResolvedValue({ data: [row({ id: 'f1', required: true, order: 4 })] });
    patchMock.mockResolvedValueOnce({ data: row({ id: 'f1', required: false, order: 0 }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.update.mutate({
      id: 'f1',
      payload: { required: false, order: 0, showOnCard: false, options: [] },
    });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

    expect(patchMock).toHaveBeenCalledWith('/projects/p1/fields/f1/', {
      required: false,
      options: [],
      order: 0,
      show_on_card: false,
    });
  });

  it('replaces the updated row in the cache and re-sorts by order', async () => {
    getMock.mockResolvedValue({
      data: [row({ id: 'a', order: 0 }), row({ id: 'b', order: 1 }), row({ id: 'c', order: 2 })],
    });
    patchMock.mockResolvedValueOnce({ data: row({ id: 'c', name: 'Moved', order: -1 }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(3));

    result.current.update.mutate({ id: 'c', payload: { order: -1 } });
    await waitFor(() => expect(result.current.fields[0].id).toBe('c'));

    expect(result.current.fields.map((f) => f.id)).toEqual(['c', 'a', 'b']);
    expect(result.current.fields[0].name).toBe('Moved');
    // No refetch — the update writes the row straight into the cache.
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('leaves untouched rows alone when writing the updated row back', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'a' }), row({ id: 'b', name: 'Keep me' })] });
    patchMock.mockResolvedValueOnce({ data: row({ id: 'a', name: 'Changed' }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(2));

    result.current.update.mutate({ id: 'a', payload: { name: 'Changed' } });
    await waitFor(() => expect(result.current.fields[0].name).toBe('Changed'));
    expect(result.current.fields[1].name).toBe('Keep me');
  });

  it('does not throw when the update lands before any list is cached', async () => {
    getMock.mockRejectedValueOnce(new Error('list unavailable'));
    patchMock.mockResolvedValueOnce({ data: row({ id: 'f1', name: 'Renamed' }) });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    result.current.update.mutate({ id: 'f1', payload: { name: 'Renamed' } });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.fields).toEqual([]);
  });

  it('reports a failed update and leaves the cached row unchanged', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'f1', name: 'Original' })] });
    patchMock.mockRejectedValueOnce(new Error('400'));

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.update.mutate({ id: 'f1', payload: { name: 'Nope' } });
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(result.current.fields[0].name).toBe('Original');
  });
});

describe('useProjectCustomFields — remove', () => {
  it('deletes the field and drops it from the cached list', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'a' }), row({ id: 'b' })] });
    deleteMock.mockResolvedValueOnce({ data: null });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(2));

    result.current.remove.mutate('a');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/fields/a/');
    expect(result.current.fields.map((f) => f.id)).toEqual(['b']);
  });

  it('leaves the list intact when the deleted id is not in the cache', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'a' })] });
    deleteMock.mockResolvedValueOnce({ data: null });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.remove.mutate('ghost');
    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
    expect(result.current.fields.map((f) => f.id)).toEqual(['a']);
  });

  it('does not throw when the delete lands before any list is cached', async () => {
    getMock.mockRejectedValueOnce(new Error('list unavailable'));
    deleteMock.mockResolvedValueOnce({ data: null });

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    result.current.remove.mutate('a');
    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
    expect(result.current.fields).toEqual([]);
  });

  it('reports a failed delete and keeps the row', async () => {
    getMock.mockResolvedValue({ data: [row({ id: 'a' })] });
    deleteMock.mockRejectedValueOnce(new Error('403'));

    const { result } = renderFields('p1');
    await waitFor(() => expect(result.current.fields).toHaveLength(1));

    result.current.remove.mutate('a');
    await waitFor(() => expect(result.current.remove.isError).toBe(true));
    expect(result.current.fields.map((f) => f.id)).toEqual(['a']);
  });
});
