/**
 * Tests for useProjects — covers the inline-mirrored mapper (drives palette
 * branches) plus the real hook (drives the ApiClient call and the
 * `isError && !isFetching` suppression branch).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

import { useProjects } from './useProjects';

// ApiProject shape returned by the backend
interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string;
  methodology?: 'WATERFALL' | 'AGILE' | 'HYBRID';
  health?: string;
  open_task_count?: number | null;
}

type HealthState = 'on-track' | 'at-risk' | 'critical' | 'unknown';

/** Inline mirror of HEALTH_STATE/toHealthState in useProjects.ts. */
const HEALTH_STATE: Record<string, HealthState> = {
  AUTO: 'unknown',
  ON_TRACK: 'on-track',
  AT_RISK: 'at-risk',
  CRITICAL: 'critical',
};
function toHealthState(health: string | undefined): HealthState {
  return HEALTH_STATE[health ?? ''] ?? 'unknown';
}

const COLOR_PALETTE: ReadonlyArray<string> = [
  '#3E8C6D',
  '#E8A020',
  '#B91C1C',
  '#6B6965',
  '#316F57',
  '#1D4ED8',
  '#7C3AED',
  '#0E7490',
];

/** Inline mirror of mapProject in useProjects.ts — must stay in sync. */
function mapProject(p: ApiProject, index: number) {
  return {
    id: p.id,
    name: p.name,
    healthState: toHealthState(p.health),
    openTaskCount: p.open_task_count ?? null,
    colorDot: COLOR_PALETTE[index % COLOR_PALETTE.length] ?? '#3E8C6D',
    methodology: p.methodology ?? ('HYBRID' as const),
  };
}

describe('useProjects mapper', () => {
  const apiProject: ApiProject = {
    id: 'proj-1',
    name: 'Alpha',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  };

  it('maps API project to Project shape', () => {
    const project = mapProject(apiProject, 0);
    expect(project.id).toBe('proj-1');
    expect(project.name).toBe('Alpha');
    expect(project.healthState).toBe('unknown');
    expect(project.openTaskCount).toBeNull();
    expect(project.colorDot).toBe('#3E8C6D');
  });

  it('cycles colorDot through the palette by index', () => {
    const colors = Array.from({ length: 8 }, (_, i) =>
      mapProject(apiProject, i).colorDot,
    );
    // palette has 8 entries — index 8 wraps back to index 0
    const wrapped = mapProject(apiProject, 8).colorDot;
    expect(wrapped).toBe(colors[0]);
    // all 8 entries are distinct
    expect(new Set(colors).size).toBe(8);
  });

  it('maps the server health enum to the dot state (#960)', () => {
    expect(mapProject({ ...apiProject, health: 'ON_TRACK' }, 0).healthState).toBe('on-track');
    expect(mapProject({ ...apiProject, health: 'AT_RISK' }, 0).healthState).toBe('at-risk');
    expect(mapProject({ ...apiProject, health: 'CRITICAL' }, 0).healthState).toBe('critical');
    // AUTO (the default "defer to rollup") and unset both stay hollow.
    expect(mapProject({ ...apiProject, health: 'AUTO' }, 0).healthState).toBe('unknown');
    expect(mapProject(apiProject, 0).healthState).toBe('unknown');
  });

  it('maps the annotated open_task_count (#960)', () => {
    expect(mapProject({ ...apiProject, open_task_count: 5 }, 0).openTaskCount).toBe(5);
    expect(mapProject({ ...apiProject, open_task_count: 0 }, 0).openTaskCount).toBe(0);
    // Null/absent on unannotated paths.
    expect(mapProject({ ...apiProject, open_task_count: null }, 0).openTaskCount).toBeNull();
    expect(mapProject(apiProject, 0).openTaskCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real-hook integration — exercises useProjects' query branches.
// ---------------------------------------------------------------------------

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useProjects hook', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('returns mapped projects on a successful fetch', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        results: [
          { id: 'p1', name: 'Alpha', description: '', start_date: '2026-01-01', calendar: 'default' },
          { id: 'p2', name: 'Beta',  description: '', start_date: '2026-02-01', calendar: 'default' },
        ],
      },
    });
    const { result } = renderHook(() => useProjects(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0]).toMatchObject({
      id: 'p1', name: 'Alpha', healthState: 'unknown',
    });
    expect(result.current.data?.[0].colorDot).toBe('#3E8C6D');
    expect(result.current.error).toBeNull();
  });

  it('surfaces the error after a final fetch failure (isFetching settled to false)', async () => {
    getMock.mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() => useProjects(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('Network down');
  });
});
