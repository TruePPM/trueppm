import { describe, expect, it } from 'vitest';
import { resolveHomeSurface } from './homeModel';
import type { CurrentUser } from '@/hooks/useCurrentUser';

const base: CurrentUser['landing'] = {
  intent: 'my_work',
  path: '/me/work',
  resolved_by: 'role_policy',
};

describe('resolveHomeSurface', () => {
  it('maps each server home onto the surface /home renders', () => {
    expect(resolveHomeSurface({ ...base, home: 'contributor' })).toEqual({ kind: 'contributor' });
    expect(resolveHomeSurface({ ...base, home: 'pm' })).toEqual({ kind: 'pm' });
    expect(resolveHomeSurface({ ...base, home: 'rm' })).toEqual({ kind: 'resources' });
    expect(
      resolveHomeSurface({
        ...base,
        home: 'exec',
        home_program: { id: 'pg-1', code: 'PG', name: 'Program' },
      }),
    ).toEqual({ kind: 'exec', programId: 'pg-1' });
  });

  it('an exec home without a program carries no program id (switcher empty state)', () => {
    expect(resolveHomeSurface({ ...base, home: 'exec', home_program: null })).toEqual({
      kind: 'exec',
      programId: null,
    });
  });

  it('a missing home (older server, no user yet) reads as the contributor home', () => {
    expect(resolveHomeSurface(base)).toEqual({ kind: 'contributor' });
    expect(resolveHomeSurface(undefined)).toEqual({ kind: 'contributor' });
  });
});
