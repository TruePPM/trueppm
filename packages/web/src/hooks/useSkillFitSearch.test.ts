/**
 * useSkillFitSearch unit tests (#3661).
 *
 * `GET /api/v1/resources/?search=&task=` is the catalog list, so every row is
 * produced by `ResourceSerializer.to_representation`, which **pops** `email`
 * below workspace ADMIN rather than nulling it — the skill-fit mode only layers
 * `skill_fit`/`missing_skills` on top of that already-stripped row. The hook's
 * wire interface used to declare `email` as a required `string`, so `tsc` could
 * not catch a consumer dereferencing it. These cases pin the mapper's behavior
 * on the absent-key path and the grouping/ordering the component relies on.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkillFitSearch } from './useSkillFitSearch';
import type { Proficiency, ResourceWithSkillFit } from '@/types';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

// --- wire-shape fixtures ----------------------------------------------------

interface WireSkill {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: Proficiency;
}

interface WireResource {
  id: string;
  name: string;
  /** Omitted entirely (not nulled) below workspace ADMIN — see #3661. */
  email?: string;
  job_role: string;
  max_units: string;
  calendar: string | null;
  skills: WireSkill[];
  skill_fit?: 'exact' | 'partial' | 'missing';
}

/** A row exactly as a **workspace ADMIN** receives it — `email` present. */
function withEmail(
  id: string,
  fit: WireResource['skill_fit'],
  skills: WireSkill[] = [],
): WireResource {
  return {
    id,
    name: `Person ${id}`,
    email: `${id}@example.com`,
    job_role: 'Engineer',
    max_units: '1.00',
    calendar: null,
    skills,
    skill_fit: fit,
  };
}

/**
 * A row exactly as every **non-workspace-Admin** caller receives it: the `email`
 * key is absent from the object, not present with a null/empty value.
 */
function withoutEmail(
  id: string,
  fit: WireResource['skill_fit'],
  skills: WireSkill[] = [],
): WireResource {
  const row = withEmail(id, fit, skills);
  delete row.email;
  return row;
}

function page(results: WireResource[]) {
  return { data: { count: results.length, next: null, previous: null, results } };
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

beforeEach(() => {
  getMock.mockReset();
});

describe('useSkillFitSearch', () => {
  it('maps a row with no email key to undefined without throwing (#3661)', async () => {
    getMock.mockResolvedValue(page([withoutEmail('r1', 'exact')]));

    const { result } = renderHook(() => useSkillFitSearch('', 't1'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const mapped = result.current.data?.exact[0];
    expect(mapped?.id).toBe('r1');
    expect(mapped?.email).toBeUndefined();
    // The domain object still carries the key, so a consumer can distinguish
    // "withheld" (undefined) from a row it never fetched.
    expect('email' in (mapped ?? {})).toBe(true);
  });

  it('passes email straight through for a workspace Admin caller', async () => {
    getMock.mockResolvedValue(page([withEmail('r1', 'exact')]));

    const { result } = renderHook(() => useSkillFitSearch('', 't1'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.exact[0].email).toBe('r1@example.com');
  });

  it('expands the flat skill/skill_name wire pair into a nested skill object', async () => {
    // The wire sends `skill` (uuid) and `skill_name` side by side; the mapper
    // synthesizes a `Skill` from them with empty normalizedName/category, which
    // the picker's SkillChip reads. Nothing else covers this branch.
    getMock.mockResolvedValue(
      page([
        withoutEmail('r1', 'exact', [
          { id: 'rs-1', resource: 'r1', skill: 'sk-1', skill_name: 'Django', proficiency: 3 },
        ]),
      ]),
    );

    const { result } = renderHook(() => useSkillFitSearch('', 't1'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.exact[0].skills).toEqual([
      {
        id: 'rs-1',
        resourceId: 'r1',
        skillId: 'sk-1',
        skill: { id: 'sk-1', name: 'Django', normalizedName: '', category: '' },
        proficiency: 3,
      },
    ]);
  });

  it('groups rows by skill_fit and defaults a missing annotation to "missing"', async () => {
    const unannotated = withoutEmail('r4', undefined);
    getMock.mockResolvedValue(
      page([
        withoutEmail('r1', 'exact'),
        withoutEmail('r2', 'partial'),
        withoutEmail('r3', 'missing'),
        unannotated,
      ]),
    );

    const { result } = renderHook(() => useSkillFitSearch('', 't1'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.exact.map((r) => r.id)).toEqual(['r1']);
    expect(result.current.data?.partial.map((r) => r.id)).toEqual(['r2']);
    expect(result.current.data?.missing.map((r) => r.id)).toEqual(['r3', 'r4']);
  });

  it('keeps `email` optional on the domain type (#3661)', () => {
    // The only *failing* control this fix has. The runtime cases above pass on
    // the broken build too — JavaScript never minded the absent key; the bug was
    // that `tsc` promised it could not be absent. `types.ts` is hand-maintained
    // with no drift gate (#2633), so a re-tightening to a required `string` is
    // caught here and nowhere else: this literal omits `email` and therefore
    // only compiles while the field is optional.
    const withheld: ResourceWithSkillFit = {
      id: 'r1',
      name: 'Person r1',
      jobRole: 'Engineer',
      maxUnits: 1,
      calendarId: null,
      skills: [],
      skillFit: 'missing',
      missingSkills: [],
    };

    expect(withheld.email).toBeUndefined();
  });

  it('issues no request without a task id', () => {
    renderHook(() => useSkillFitSearch('alice', ''), { wrapper: makeWrapper() });

    expect(getMock).not.toHaveBeenCalled();
  });
});
