/**
 * useProjectResourcePool unit tests (#2459 coverage backfill).
 *
 * The four hooks in this module share one mapper (`mapProjectResource`) whose
 * branches are the risky part: `units_override` is a nullable *string* on the
 * wire and must become `number | null`, `is_me` is optional, and the skills
 * array may be empty. The write hooks each build a partial request body from
 * optional payload fields — a regression there silently sends `undefined`
 * (dropped by JSON) or clobbers a field the caller never intended to touch.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAddProjectResource,
  useProjectResourcePool,
  useRemoveProjectResource,
  useUpdateProjectResource,
} from './useProjectResourcePool';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

// --- wire-shape fixtures ----------------------------------------------------

interface WireSkill {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: 1 | 2 | 3;
}

interface WireProjectResource {
  id: string;
  project: string;
  resource: string;
  resource_detail: {
    id: string;
    name: string;
    email: string;
    job_role: string;
    max_units: string;
    calendar: string | null;
    skills: WireSkill[];
    is_me?: boolean;
  };
  role_title: string;
  units_override: string | null;
  effective_max_units: string;
  notes: string;
}

function wire(overrides: Partial<WireProjectResource> = {}): WireProjectResource {
  return {
    id: 'pr1',
    project: 'p1',
    resource: 'r1',
    resource_detail: {
      id: 'r1',
      name: 'Alice',
      email: 'alice@example.com',
      job_role: 'Engineer',
      max_units: '1.00',
      calendar: null,
      skills: [],
    },
    role_title: 'Lead',
    units_override: null,
    effective_max_units: '1.00',
    notes: '',
    ...overrides,
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// useProjectResourcePool (GET)
// ---------------------------------------------------------------------------

describe('useProjectResourcePool', () => {
  it('requests the pool scoped to the project and maps the wire rows', async () => {
    getMock.mockResolvedValueOnce({ data: { count: 1, next: null, previous: null, results: [wire()] } });
    const { result } = renderHook(() => useProjectResourcePool('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/project-resources/', { params: { project: 'p1' } });
    expect(result.current.data).toEqual([
      {
        id: 'pr1',
        projectId: 'p1',
        resourceId: 'r1',
        resource: {
          id: 'r1',
          name: 'Alice',
          email: 'alice@example.com',
          jobRole: 'Engineer',
          maxUnits: 1,
          calendarId: null,
          skills: [],
          isMe: undefined,
        },
        roleTitle: 'Lead',
        unitsOverride: null,
        effectiveMaxUnits: 1,
        notes: '',
      },
    ]);
  });

  it('parses a non-null units_override into a number', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        count: 1,
        next: null,
        previous: null,
        results: [wire({ units_override: '0.50', effective_max_units: '0.50' })],
      },
    });
    const { result } = renderHook(() => useProjectResourcePool('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].unitsOverride).toBe(0.5);
    expect(result.current.data?.[0].effectiveMaxUnits).toBe(0.5);
  });

  it('maps skills and the is_me flag when the server populates them', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        count: 1,
        next: null,
        previous: null,
        results: [
          wire({
            resource_detail: {
              id: 'r1',
              name: 'Alice',
              email: 'alice@example.com',
              job_role: 'Engineer',
              max_units: '1.00',
              calendar: 'cal-1',
              is_me: true,
              skills: [
                { id: 's1', resource: 'r1', skill: 'sk1', skill_name: 'React', proficiency: 3 },
              ],
            },
          }),
        ],
      },
    });
    const { result } = renderHook(() => useProjectResourcePool('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const resource = result.current.data?.[0].resource;
    expect(resource?.isMe).toBe(true);
    expect(resource?.calendarId).toBe('cal-1');
    expect(resource?.skills).toEqual([
      {
        id: 's1',
        resourceId: 'r1',
        skillId: 'sk1',
        skill: { id: 'sk1', name: 'React', normalizedName: '', category: '' },
        proficiency: 3,
      },
    ]);
  });

  it('stays disabled and issues no request when the project id is empty', () => {
    const { result } = renderHook(() => useProjectResourcePool(''), {
      wrapper: makeWrapper(makeQC()),
    });

    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('surfaces the error state when the request fails', async () => {
    getMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useProjectResourcePool('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// useAddProjectResource (POST)
// ---------------------------------------------------------------------------

describe('useAddProjectResource', () => {
  it('defaults the optional fields so the server never receives undefined', async () => {
    postMock.mockResolvedValueOnce({ data: wire() });
    const { result } = renderHook(() => useAddProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ projectId: 'p1', resourceId: 'r1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/project-resources/', {
      project: 'p1',
      resource: 'r1',
      role_title: '',
      units_override: null,
      notes: '',
    });
  });

  it('forwards the supplied role, units override and notes verbatim', async () => {
    postMock.mockResolvedValueOnce({
      data: wire({ role_title: 'QA', units_override: '0.25', notes: 'part time' }),
    });
    const { result } = renderHook(() => useAddProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({
      projectId: 'p1',
      resourceId: 'r1',
      roleTitle: 'QA',
      unitsOverride: 0.25,
      notes: 'part time',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/project-resources/', {
      project: 'p1',
      resource: 'r1',
      role_title: 'QA',
      units_override: 0.25,
      notes: 'part time',
    });
    expect(result.current.data?.roleTitle).toBe('QA');
    expect(result.current.data?.unitsOverride).toBe(0.25);
  });

  it('treats an explicit null units override as "no override"', async () => {
    postMock.mockResolvedValueOnce({ data: wire() });
    const { result } = renderHook(() => useAddProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ projectId: 'p1', resourceId: 'r1', unitsOverride: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/project-resources/', {
      project: 'p1',
      resource: 'r1',
      role_title: '',
      units_override: null,
      notes: '',
    });
  });

  it('invalidates the pool query on success', async () => {
    postMock.mockResolvedValueOnce({ data: wire() });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAddProjectResource('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ projectId: 'p1', resourceId: 'r1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-resource-pool', 'p1'] });
  });

  it('reports an error and does not invalidate when the POST fails', async () => {
    postMock.mockRejectedValueOnce(new Error('409'));
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAddProjectResource('p1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ projectId: 'p1', resourceId: 'r1' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useUpdateProjectResource (PATCH)
// ---------------------------------------------------------------------------

describe('useUpdateProjectResource', () => {
  it('sends an empty body when no editable field was supplied', async () => {
    patchMock.mockResolvedValueOnce({ data: wire() });
    const { result } = renderHook(() => useUpdateProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/project-resources/pr1/', {});
  });

  it('omits the fields the caller left undefined so they are not clobbered', async () => {
    patchMock.mockResolvedValueOnce({ data: wire({ role_title: 'Reviewer' }) });
    const { result } = renderHook(() => useUpdateProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', roleTitle: 'Reviewer' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/project-resources/pr1/', {
      role_title: 'Reviewer',
    });
  });

  it('includes a units override of null so it can be cleared explicitly', async () => {
    patchMock.mockResolvedValueOnce({ data: wire() });
    const { result } = renderHook(() => useUpdateProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', unitsOverride: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/project-resources/pr1/', {
      units_override: null,
    });
  });

  it('sends every field when all three are supplied and maps the response', async () => {
    patchMock.mockResolvedValueOnce({
      data: wire({ role_title: 'Lead', units_override: '0.75', notes: 'shared' }),
    });
    const { result } = renderHook(() => useUpdateProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', roleTitle: 'Lead', unitsOverride: 0.75, notes: 'shared' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/project-resources/pr1/', {
      role_title: 'Lead',
      units_override: 0.75,
      notes: 'shared',
    });
    expect(result.current.data?.unitsOverride).toBe(0.75);
    expect(result.current.data?.notes).toBe('shared');
  });

  it('invalidates the pool query on success', async () => {
    patchMock.mockResolvedValueOnce({ data: wire() });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProjectResource('p2'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'pr1', notes: 'x' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-resource-pool', 'p2'] });
  });

  it('reports an error when the PATCH fails', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useUpdateProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', notes: 'x' });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// useRemoveProjectResource (DELETE)
// ---------------------------------------------------------------------------

describe('useRemoveProjectResource', () => {
  it('omits the force param on a non-forced delete', async () => {
    deleteMock.mockResolvedValueOnce({
      data: { detail: 'Removed.', cascaded_assignment_count: 0 },
    });
    const { result } = renderHook(() => useRemoveProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', force: false });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteMock).toHaveBeenCalledWith('/project-resources/pr1/', { params: {} });
    expect(result.current.data).toEqual({ detail: 'Removed.', cascadedAssignmentCount: 0 });
  });

  it('sends force=true and surfaces the cascaded assignment count on a forced delete', async () => {
    deleteMock.mockResolvedValueOnce({
      data: { detail: 'Removed with cascade.', cascaded_assignment_count: 3 },
    });
    const { result } = renderHook(() => useRemoveProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', force: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteMock).toHaveBeenCalledWith('/project-resources/pr1/', {
      params: { force: 'true' },
    });
    expect(result.current.data).toEqual({
      detail: 'Removed with cascade.',
      cascadedAssignmentCount: 3,
    });
  });

  it('exposes the 409 response so the caller can offer the force path', async () => {
    deleteMock.mockRejectedValueOnce({
      response: { status: 409, data: { detail: 'Resource has assignments.' } },
    });
    const { result } = renderHook(() => useRemoveProjectResource('p1'), {
      wrapper: makeWrapper(makeQC()),
    });

    result.current.mutate({ id: 'pr1', force: false });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.response?.status).toBe(409);
  });

  it('invalidates the pool query on success', async () => {
    deleteMock.mockResolvedValueOnce({
      data: { detail: 'Removed.', cascaded_assignment_count: 0 },
    });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveProjectResource('p3'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'pr1', force: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-resource-pool', 'p3'] });
  });
});
