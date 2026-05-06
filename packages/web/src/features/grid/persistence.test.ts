import { describe, it, expect, beforeEach } from 'vitest';
import { loadMode, saveMode, loadGroupBy, saveGroupBy } from './persistence';

beforeEach(() => {
  window.localStorage.clear();
});

describe('persistence — mode', () => {
  it('round-trips a valid mode', () => {
    saveMode('p1', 'flat');
    expect(loadMode('p1')).toBe('flat');
  });

  it('returns undefined when no value is stored', () => {
    expect(loadMode('p1')).toBeUndefined();
  });

  it('returns undefined for an out-of-union value (corrupt storage)', () => {
    window.localStorage.setItem('trueppm.grid.mode.p1.v1', 'banana');
    expect(loadMode('p1')).toBeUndefined();
  });

  it('keys are scoped per project', () => {
    saveMode('p1', 'outline');
    saveMode('p2', 'flat');
    expect(loadMode('p1')).toBe('outline');
    expect(loadMode('p2')).toBe('flat');
  });
});

describe('persistence — groupBy', () => {
  it('round-trips a valid groupBy', () => {
    saveGroupBy('p1', 'resource');
    expect(loadGroupBy('p1')).toBe('resource');
  });

  it('returns undefined when no value is stored', () => {
    expect(loadGroupBy('p1')).toBeUndefined();
  });

  it('returns undefined for an out-of-union value', () => {
    window.localStorage.setItem('trueppm.grid.groupBy.p1.v1', 'flavor');
    expect(loadGroupBy('p1')).toBeUndefined();
  });
});
