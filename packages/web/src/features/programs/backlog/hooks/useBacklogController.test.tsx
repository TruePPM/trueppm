/**
 * useBacklogController — the single source of truth shared by the desktop and
 * mobile backlog shells. The parts a fixture/manual click rarely exercises but
 * a regression absolutely will: the RBAC gates, the page-error classification,
 * the facet/search derivation, and the optimistic-pull → toast → retry
 * choreography (decision D6). The query (apiClient), program detail, and member
 * projects are mocked; the pull function is injected so success and failure are
 * both forced.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ApiBacklogItem } from '../api';
import type { MemberProject } from '../types';
import { useBacklogController } from './useBacklogController';
import type { UsePullItemOptions } from './usePullItem';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

const useProgramMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useProgram', () => ({ useProgram: useProgramMock }));

const useProgramProjectsMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useProgramProjects', () => ({ useProgramProjects: useProgramProjectsMock }));

const PROGRAM = 'p1';

const PROJECT: MemberProject = { id: 'pr-1', name: 'Avionics', color: '#abc' };

function apiItem(overrides: Partial<ApiBacklogItem> = {}): ApiBacklogItem {
  return {
    id: 'BI-1',
    server_version: 1,
    program: PROGRAM,
    title: 'Telemetry channel',
    description: '',
    item_type: 'story',
    status: 'proposed',
    tags: ['alpha'],
    priority_rank: 1,
    story_points: null,
    pulled_task: null,
    pulled_task_project_id: null,
    pulled_task_project_name: null,
    pulled_at: null,
    pulled_by: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const ITEMS = [
  apiItem({ id: 'BI-1', title: 'Alpha radio', status: 'proposed', tags: ['rf'], priority_rank: 1 }),
  apiItem({ id: 'BI-2', title: 'Beacon', status: 'pulled', tags: ['rf', 'nav'], priority_rank: 2 }),
  apiItem({ id: 'BI-3', title: 'Archived bit', status: 'archived', tags: [], priority_rank: 3 }),
];

interface SetupOptions {
  role?: number;
  pullOptions?: UsePullItemOptions;
  getImpl?: () => Promise<unknown>;
}

function setup({ role = ROLE_ADMIN, pullOptions, getImpl }: SetupOptions = {}) {
  getMock.mockImplementation(getImpl ?? (() => Promise.resolve({ data: ITEMS })));
  useProgramMock.mockReturnValue({
    data: { id: PROGRAM, name: 'Polaris', code: 'PLR', color: '#123', my_role: role },
  });
  useProgramProjectsMock.mockReturnValue({ data: [{ id: 'pr-1', name: 'Avionics', colorDot: '#abc' }] });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { initialEntries: ['/backlog'] },
      createElement(QueryClientProvider, { client: qc }, children),
    );
  }
  return renderHook(() => useBacklogController(PROGRAM, pullOptions), { wrapper: Wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useBacklogController RBAC gates', () => {
  it('grants edit at Admin and above, delete only at Owner', async () => {
    const admin = setup({ role: ROLE_ADMIN });
    await waitFor(() => expect(admin.result.current.isLoading).toBe(false));
    expect(admin.result.current.canEdit).toBe(true);
    expect(admin.result.current.canDelete).toBe(false);

    const owner = setup({ role: ROLE_OWNER });
    await waitFor(() => expect(owner.result.current.isLoading).toBe(false));
    expect(owner.result.current.canDelete).toBe(true);
  });

  it('denies edit below Admin', async () => {
    const member = setup({ role: ROLE_MEMBER });
    await waitFor(() => expect(member.result.current.isLoading).toBe(false));
    expect(member.result.current.canEdit).toBe(false);
    expect(member.result.current.canDelete).toBe(false);
  });
});

describe('useBacklogController derivation', () => {
  it('splits pulled rows, hides archived in the All view, and counts every status', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.allItems).toHaveLength(3));

    expect(result.current.counts).toEqual({ all: 3, proposed: 1, pulled: 1, archived: 1 });
    expect(result.current.mainItems.map((i) => i.id)).toEqual(['BI-1']);
    expect(result.current.pulledItems.map((i) => i.id)).toEqual(['BI-2']);
    expect(result.current.tagUniverse).toEqual(['nav', 'rf']);
    expect(result.current.memberProjects).toEqual([PROJECT]);
  });

  it('search drives matchCount without removing rows', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.allItems).toHaveLength(3));

    expect(result.current.searchActive).toBe(false);
    act(() => result.current.url.setQuery('alpha'));
    await waitFor(() => expect(result.current.searchActive).toBe(true));
    expect(result.current.matchCount).toBe(1);
    // Facet list is unchanged — search dims, it does not filter rows out.
    expect(result.current.mainItems.map((i) => i.id)).toEqual(['BI-1']);
  });
});

describe('useBacklogController error classification', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'generic'],
  ])('maps a %s response to errorKind %s', async (status, kind) => {
    const { result } = setup({
      getImpl: () => Promise.reject(Object.assign(new Error('http'), { response: { status } })),
    });
    await waitFor(() => expect(result.current.errorKind).toBe(kind));
  });
});

describe('useBacklogController pull choreography', () => {
  it('shows a success toast and clears the pending row on a successful pull', async () => {
    const pullFn = vi.fn().mockResolvedValue({ taskId: 't-42' });
    const { result } = setup({ pullOptions: { pullFn } });
    await waitFor(() => expect(result.current.allItems).toHaveLength(3));
    const item = result.current.allItems[0];

    act(() => result.current.pullItem(item, PROJECT));

    // projectId is set the instant the pull starts (the user picked it); taskId
    // is filled in on success so the toast can deep-link to the task (#1994).
    expect(result.current.toast).toMatchObject({
      kind: 'success',
      message: 'Pulled to Avionics.',
      projectId: PROJECT.id,
    });
    expect(result.current.pendingPullItemId).toBe(item.id);
    expect(result.current.liveMessage).toContain('Avionics');

    await waitFor(() => expect(result.current.pendingPullItemId).toBeNull());
    expect(result.current.toast).toMatchObject({ kind: 'success', taskId: 't-42' });
    expect(pullFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces a retryable error toast when the pull rejects', async () => {
    const pullFn = vi.fn().mockRejectedValue({ response: { data: { detail: 'Project archived' } } });
    const { result } = setup({ pullOptions: { pullFn } });
    await waitFor(() => expect(result.current.allItems).toHaveLength(3));
    const item = result.current.allItems[0];

    act(() => result.current.pullItem(item, PROJECT));

    await waitFor(() => expect(result.current.toast?.kind).toBe('error'));
    expect(result.current.toast).toMatchObject({ message: 'Project archived', project: PROJECT });
    expect(result.current.pendingPullItemId).toBeNull();
    expect(result.current.alertMessage).toContain('back in proposed');
  });

  it('retryPull re-fires the pull from the error toast', async () => {
    const pullFn = vi
      .fn()
      .mockRejectedValueOnce({ response: { data: { detail: 'boom' } } })
      .mockResolvedValueOnce({ taskId: 't-9' });
    const { result } = setup({ pullOptions: { pullFn } });
    await waitFor(() => expect(result.current.allItems).toHaveLength(3));
    const item = result.current.allItems[0];

    act(() => result.current.pullItem(item, PROJECT));
    await waitFor(() => expect(result.current.toast?.kind).toBe('error'));

    act(() => result.current.retryPull());
    await waitFor(() => expect(pullFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.toast?.kind).toBe('success'));
  });

  it('auto-dismisses the success toast after the timeout', async () => {
    vi.useFakeTimers();
    const pullFn = vi.fn().mockResolvedValue({ taskId: 't-1' });
    const { result } = setup({ pullOptions: { pullFn } });
    await vi.waitFor(() => expect(result.current.allItems).toHaveLength(3));
    const item = result.current.allItems[0];

    act(() => result.current.pullItem(item, PROJECT));
    expect(result.current.toast?.kind).toBe('success');

    act(() => {
      // The pull toast lingers longer than a bare confirmation (PULL_TOAST_MS =
      // 8000) because it offers a "Go to task" hop (#1994).
      vi.advanceTimersByTime(8000);
    });
    expect(result.current.toast).toBeNull();
  });

  it('notify raises a transient success toast and dismissToast clears it', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.notify('Coming soon'));
    expect(result.current.toast).toEqual({ kind: 'success', message: 'Coming soon' });

    act(() => result.current.dismissToast());
    expect(result.current.toast).toBeNull();
  });
});
