import { describe, expect, it } from 'vitest';
import { OWNER_PARAM, STATUS_PARAM, parseIdList, serializeIdList } from './facetParams';
import { parseLabelIds, serializeLabelIds } from './labelFilter';

describe('parseIdList', () => {
  it('splits a comma-separated list', () => {
    expect(parseIdList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('treats a single value as a one-item list — the back-compat guarantee', () => {
    // Every `?owner=Alice` / `?status=IN_PROGRESS` link bookmarked before the
    // facets went multi-select has to keep resolving. This is the whole reason
    // the format is a list rather than a new param name.
    expect(parseIdList('Alice')).toEqual(['Alice']);
  });

  it('trims whitespace and drops blanks', () => {
    expect(parseIdList(' a , ,b ,')).toEqual(['a', 'b']);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(parseIdList('b,a,b,c,a')).toEqual(['b', 'a', 'c']);
  });

  it('returns an empty list for null, undefined and empty string', () => {
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList('')).toEqual([]);
  });
});

describe('serializeIdList', () => {
  it('joins with commas', () => {
    expect(serializeIdList(['a', 'b'])).toBe('a,b');
  });

  it('yields an empty string for an empty selection, so the host drops the key', () => {
    expect(serializeIdList([])).toBe('');
  });

  it('round-trips through parse', () => {
    expect(parseIdList(serializeIdList(['x', 'y', 'z']))).toEqual(['x', 'y', 'z']);
  });
});

describe('param keys', () => {
  it('keeps the keys the Grid already shipped', () => {
    // Renaming either would break every existing bookmark for no gain.
    expect(OWNER_PARAM).toBe('owner');
    expect(STATUS_PARAM).toBe('status');
  });
});

describe('labelFilter delegates to the shared list codec', () => {
  it('parses and serializes identically', () => {
    // One implementation, so `?fl=`, `?owner=` and `?status=` cannot drift into
    // three subtly different list formats.
    expect(parseLabelIds(' l1 ,l2,l1')).toEqual(parseIdList(' l1 ,l2,l1'));
    expect(serializeLabelIds(['l1', 'l2'])).toBe(serializeIdList(['l1', 'l2']));
  });
});
