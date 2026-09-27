import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useApplyTemplate,
  useDeleteUntouchedSeededTasks,
  useProjectTemplates,
  usePublishPreview,
  usePublishTemplate,
  useTemplateApplication,
  useTemplateDivergence,
  useTemplatesFromProject,
  useUndoTemplateApplication,
  type ProjectTemplate,
  type TemplateApplication,
} from './useProjectTemplates';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));

function template(overrides: Partial<ProjectTemplate> = {}): ProjectTemplate {
  return {
    id: 'tpl1',
    name: 'Standard build',
    description: '',
    source_kind: 'workspace',
    provenance: 'Workspace',
    carries: ['structure'],
    methodology: 'HYBRID',
    task_count: 12,
    version: 1,
    program: null,
    published_at: '2026-04-01T00:00:00Z',
    source_project: 'p1',
    ...overrides,
  };
}

function application(status: TemplateApplication['status']): TemplateApplication {
  return {
    id: 'app1',
    template: 'tpl1',
    template_name: 'Standard build',
    template_version: 1,
    project: 'p2',
    status,
    result_summary: {},
    error_detail: '',
    created_at: '2026-04-01T00:00:00Z',
    completed_at: null,
    undone_at: null,
  };
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('useProjectTemplates', () => {
  it('reads the gallery unscoped and unwraps a paginated body', async () => {
    getMock.mockResolvedValue({
      data: { count: 1, next: null, previous: null, results: [template()] },
    });
    const { result } = renderHook(() => useProjectTemplates(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/project-templates/', { params: undefined });
    expect(result.current.data?.[0].id).toBe('tpl1');
  });

  it('scopes the gallery to a program and accepts a bare array body', async () => {
    getMock.mockResolvedValue({ data: [template({ program: 'pg1' })] });
    const { result } = renderHook(() => useProjectTemplates('pg1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/project-templates/', { params: { program: 'pg1' } });
    expect(result.current.data).toHaveLength(1);
  });
});

describe('useTemplatesFromProject', () => {
  it('filters the gallery to templates published from the given project', async () => {
    getMock.mockResolvedValue({
      data: [template(), template({ id: 'tpl2', source_project: 'other' })],
    });
    const { result } = renderHook(() => useTemplatesFromProject('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((t) => t.id)).toEqual(['tpl1']);
  });

  it('is disabled without a project', () => {
    const { result } = renderHook(() => useTemplatesFromProject(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useTemplateApplication', () => {
  it('polls while the application is running and stops once terminal', async () => {
    getMock.mockResolvedValueOnce({ data: application('running') });
    getMock.mockResolvedValueOnce({ data: application('success') });
    const { result } = renderHook(() => useTemplateApplication('app1'), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('running'));
    expect(getMock).toHaveBeenCalledWith('/template-applications/app1/');
    // The refetch interval is 2 s while running; drive it from the query itself.
    const q = qc.getQueryCache().find({ queryKey: ['template-application', 'app1'] });
    const interval = q?.options as { refetchInterval?: (q: unknown) => number | false };
    expect(interval.refetchInterval?.(q)).toBe(2000);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.status).toBe('success'));
    expect(interval.refetchInterval?.(q)).toBe(false);
  });

  it('is disabled without an application id', () => {
    const { result } = renderHook(() => useTemplateApplication(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('usePublishPreview', () => {
  it('sends the project, and the name only when one is typed', async () => {
    getMock.mockResolvedValue({ data: { name_taken: false, next_version: 1 } });
    const { result } = renderHook(() => usePublishPreview('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenLastCalledWith('/project-templates/publish-preview/', {
      params: { project: 'p1' },
    });

    const { result: named } = renderHook(() => usePublishPreview('p1', 'Standard'), { wrapper });
    await waitFor(() => expect(named.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenLastCalledWith('/project-templates/publish-preview/', {
      params: { project: 'p1', name: 'Standard' },
    });
  });

  it('is disabled without a project', () => {
    const { result } = renderHook(() => usePublishPreview(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useTemplateDivergence', () => {
  it('reads the digest for the project and is disabled without one', async () => {
    getMock.mockResolvedValue({ data: { project: 'p1', adopted: false } });
    const { result } = renderHook(() => useTemplateDivergence('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/template-divergence/');
    const { result: off } = renderHook(() => useTemplateDivergence(null), { wrapper });
    expect(off.current.fetchStatus).toBe('idle');
  });
});

describe('template mutations', () => {
  it('apply posts the target project and resolves with the application id', async () => {
    postMock.mockResolvedValue({ data: { queued: true, application: 'app1' } });
    const { result } = renderHook(() => useApplyTemplate(), { wrapper });
    let data: { queued: boolean; application: string } | undefined;
    await act(async () => {
      data = await result.current.mutateAsync({ templateId: 'tpl1', projectId: 'p2' });
    });
    expect(postMock).toHaveBeenCalledWith('/project-templates/tpl1/apply/', { project: 'p2' });
    expect(data?.application).toBe('app1');
  });

  it('undo posts to the application and returns the kept/deleted counts', async () => {
    postMock.mockResolvedValue({
      data: { ...application('undone'), undo: { deleted: 10, kept: 2 } },
    });
    const { result } = renderHook(() => useUndoTemplateApplication(), { wrapper });
    let data: { undo: { deleted: number; kept: number } } | undefined;
    await act(async () => {
      data = await result.current.mutateAsync('app1');
    });
    expect(postMock).toHaveBeenCalledWith('/template-applications/app1/undo/', {});
    expect(data?.undo).toEqual({ deleted: 10, kept: 2 });
  });

  it('delete-untouched carries only the project id', async () => {
    postMock.mockResolvedValue({ data: { deleted: 7 } });
    const { result } = renderHook(() => useDeleteUntouchedSeededTasks(), { wrapper });
    let data: { deleted: number } | undefined;
    await act(async () => {
      data = await result.current.mutateAsync('p2');
    });
    expect(postMock).toHaveBeenCalledWith('/tasks/delete-untouched-seeded/', { project: 'p2' });
    expect(data).toEqual({ deleted: 7 });
  });

  it('publish sends the minimal body by default and the optional fields when set', async () => {
    postMock.mockResolvedValue({ data: template() });
    const { result } = renderHook(() => usePublishTemplate(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'p1', name: 'Standard build' });
    });
    expect(postMock).toHaveBeenLastCalledWith('/project-templates/publish/', {
      project: 'p1',
      name: 'Standard build',
      description: '',
    });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'p1',
        name: 'Standard build',
        description: 'v2',
        sourceKind: 'personal',
        newVersion: true,
      });
    });
    expect(postMock).toHaveBeenLastCalledWith('/project-templates/publish/', {
      project: 'p1',
      name: 'Standard build',
      description: 'v2',
      source_kind: 'personal',
      new_version: true,
    });
  });
});
