import { describe, it, expect } from 'vitest';
import { classifyPertTriple, parsePertInput } from './pertTriple';

describe('classifyPertTriple', () => {
  it('is none for an all-blank triple', () => {
    expect(classifyPertTriple(null, null, null)).toEqual({ kind: 'none' });
  });
  it('is incomplete for a partial or unusable triple', () => {
    expect(classifyPertTriple(1, null, 3)).toEqual({ kind: 'incomplete' });
    expect(classifyPertTriple(1, Number.NaN, 3)).toEqual({ kind: 'incomplete' });
  });
  it('is out_of_order when O <= M <= P fails', () => {
    expect(classifyPertTriple(5, 4, 8)).toEqual({ kind: 'out_of_order' });
  });
  it('is ok for an ordered triple, ties allowed', () => {
    expect(classifyPertTriple(2, 2, 2)).toEqual({ kind: 'ok', o: 2, m: 2, p: 2 });
  });
});

describe('parsePertInput', () => {
  it('maps blank to null and invalid or negative to NaN', () => {
    expect(parsePertInput('  ')).toBeNull();
    expect(parsePertInput('3')).toBe(3);
    expect(parsePertInput('-1')).toBeNaN();
    expect(parsePertInput('x')).toBeNaN();
  });
});
