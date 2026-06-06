import { describe, it, expect } from 'vitest';
import { seedImportErrors } from './useProgramSeedIo';

describe('seedImportErrors', () => {
  it('extracts the server error list from a 400 response', () => {
    const error = { response: { data: { errors: ['$.program.name: required', '$.x: bad'] } } };
    expect(seedImportErrors(error)).toEqual(['$.program.name: required', '$.x: bad']);
  });

  it('returns an empty list when there is no structured error payload', () => {
    expect(seedImportErrors(new Error('network'))).toEqual([]);
    expect(seedImportErrors(undefined)).toEqual([]);
    expect(seedImportErrors({ response: { data: {} } })).toEqual([]);
  });
});
