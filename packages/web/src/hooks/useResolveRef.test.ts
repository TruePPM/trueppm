import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// The global test setup replaces useResolveRef with an identity resolver; this file
// tests the real module.
vi.mock('@/hooks/useResolveRef', async (importOriginal) => importOriginal());

import { findCachedResolution, isResolveNotFound, resolveQueryKey } from './useResolveRef';

const ID = '6f1c2b1e-9a57-4c1e-8d4f-2a0b7c9e1d33';

describe('findCachedResolution', () => {
  it('answers a current key from a cached project detail, case-insensitively', () => {
    const client = new QueryClient();
    client.setQueryData(['project', ID], { id: ID, code: 'PLAT', program: 'prog-1' });
    expect(findCachedResolution(client, 'project', 'plat')).toEqual({
      type: 'project',
      id: ID,
      project_id: ID,
      program_id: 'prog-1',
      key: 'PLAT',
      canonical_ref: 'PLAT',
    });
  });

  it('answers from the project list too', () => {
    const client = new QueryClient();
    client.setQueryData(['projects'], { items: [{ id: ID, code: 'CORE' }], count: 1 });
    expect(findCachedResolution(client, 'project', 'CORE')?.id).toBe(ID);
  });

  it('answers a program key from the program list', () => {
    const client = new QueryClient();
    client.setQueryData(['programs'], [{ id: ID, code: 'atlas-launch' }]);
    expect(findCachedResolution(client, 'program', 'ATLAS-LAUNCH')).toMatchObject({
      type: 'program',
      id: ID,
      program_id: ID,
    });
  });

  it('misses a retired key or a reference — those are the resolver’s to answer', () => {
    const client = new QueryClient();
    client.setQueryData(['project', ID], { id: ID, code: 'PLAT' });
    expect(findCachedResolution(client, 'project', 'OLDKEY')).toBeUndefined();
    expect(findCachedResolution(client, 'project', 'PLAT-T-10')).toBeUndefined();
  });

  it('ignores other shapes cached under the same root and blank keys', () => {
    const client = new QueryClient();
    client.setQueryData(['project', ID, 'risks'], [{ id: 'r1', code: 'PLAT' }]);
    client.setQueryData(['project', 'other'], { id: 'other', code: '' });
    expect(findCachedResolution(client, 'project', 'PLAT')).toBeUndefined();
    expect(findCachedResolution(client, 'project', '')).toBeUndefined();
  });
});

describe('resolve helpers', () => {
  it('keys the query by kind and the raw ref', () => {
    expect(resolveQueryKey('project', 'GA-SEC-T-10')).toEqual([
      'resolve',
      'project',
      'GA-SEC-T-10',
    ]);
  });

  it('treats only an HTTP not-found class as "not available"', () => {
    const httpError = (status: number) =>
      Object.assign(new Error('x'), { isAxiosError: true, response: { status } });
    expect(isResolveNotFound(httpError(404))).toBe(true);
    expect(isResolveNotFound(httpError(500))).toBe(false);
    expect(isResolveNotFound(new Error('network'))).toBe(false);
  });
});
