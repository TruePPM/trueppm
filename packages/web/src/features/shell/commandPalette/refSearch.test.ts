import { describe, expect, it, vi } from 'vitest';
import type { ResolveResponse } from '@/api/types';
import { buildRefItems, looksLikeRef, refRoute } from './refSearch';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';

function resolved(overrides: Partial<ResolveResponse> = {}): ResolveResponse {
  return {
    type: 'task',
    id: TASK,
    project_id: PROJECT,
    program_id: null,
    key: 'PLAT',
    canonical_ref: 'PLAT-T-10',
    ...overrides,
  };
}

describe('looksLikeRef', () => {
  it.each(['PLAT-T-10', 'plat-t-10', 'GA-SEC-SP-3', 'PLAT-R-7', 'PLAT', 'GA-SEC', 'PLAT2'])(
    'asks the resolver about %s',
    (q) => expect(looksLikeRef(q)).toBe(true),
  );

  it.each(['plan', 'risk', 'Platform', 'P', 'PLAT T 10', 'plat-x-10', '', 'A'.repeat(65)])(
    'leaves %s to the ordinary search',
    (q) => expect(looksLikeRef(q)).toBe(false),
  );
});

describe('refRoute', () => {
  it('opens a task drawer under the current key', () => {
    expect(refRoute(resolved(), 'unified')).toMatch(
      new RegExp(`^/projects/PLAT/.+\\?task=${TASK}$`),
    );
  });

  it('falls back to the project UUID for a keyless project', () => {
    expect(refRoute(resolved({ key: null, canonical_ref: TASK }), 'unified')).toContain(
      `/projects/${PROJECT}/`,
    );
  });

  it('routes projects, programs, sprints and risks', () => {
    expect(
      refRoute(resolved({ type: 'project', id: PROJECT, canonical_ref: 'PLAT' }), 'unified'),
    ).toBe('/projects/PLAT/overview');
    expect(
      refRoute(
        resolved({
          type: 'program',
          id: PROJECT,
          project_id: null,
          key: 'atlas',
          canonical_ref: 'atlas',
        }),
        'unified',
      ),
    ).toBe('/programs/atlas/overview');
    expect(refRoute(resolved({ type: 'sprint' }), 'unified')).toBe(
      `/projects/PLAT/board?sprint=${TASK}`,
    );
    expect(refRoute(resolved({ type: 'risk' }), 'unified')).toBe('/projects/PLAT/risk');
  });

  it('refuses a child with no project to route under', () => {
    expect(refRoute(resolved({ project_id: null }), 'unified')).toBeNull();
  });
});

describe('buildRefItems', () => {
  const go = vi.fn((path: string) => () => path);

  it('builds nothing for no answer or a 404', () => {
    expect(buildRefItems(undefined, 'PLAT-T-10', go, 'unified')).toEqual([]);
    expect(buildRefItems(null, 'PLAT-T-10', go, 'unified')).toEqual([]);
  });

  it('labels the row with the current form and keeps the typed query matchable', () => {
    const [item] = buildRefItems(resolved(), 'plat-t-10', go, 'unified');
    expect(item).toMatchObject({ label: 'PLAT-T-10', group: 'reference', tag: 'Task' });
    expect(item?.detail).toBeUndefined();
    expect(item?.keywords).toContain('plat-t-10');
  });

  it('says what a renamed key is called now', () => {
    const [item] = buildRefItems(
      resolved({ key: 'CORE', canonical_ref: 'CORE-T-10' }),
      'PLAT-T-10',
      go,
      'unified',
    );
    expect(item?.label).toBe('CORE-T-10');
    expect(item?.detail).toBe('Now CORE-T-10 (was PLAT-T-10)');
    expect(item?.keywords).toContain('PLAT-T-10');
  });
});
