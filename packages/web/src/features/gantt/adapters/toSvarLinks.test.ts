import { describe, expect, it } from 'vitest';
import { toSvarLink, toSvarLinks } from './toSvarLinks';
import type { TaskLink } from '@/types';

const base: TaskLink = { id: 'l1', sourceId: 't1', targetId: 't2', type: 'FS', isCritical: false };

describe('toSvarLink', () => {
  it('maps FS → e2s', () => {
    expect(toSvarLink(base).type).toBe('e2s');
  });

  it('maps SS → s2s', () => {
    expect(toSvarLink({ ...base, type: 'SS' }).type).toBe('s2s');
  });

  it('maps FF → e2e', () => {
    expect(toSvarLink({ ...base, type: 'FF' }).type).toBe('e2e');
  });

  it('maps SF → s2e', () => {
    expect(toSvarLink({ ...base, type: 'SF' }).type).toBe('s2e');
  });

  it('maps source/target ids', () => {
    const result = toSvarLink(base);
    expect(result.source).toBe('t1');
    expect(result.target).toBe('t2');
  });

  it('passes $critical flag through', () => {
    expect(toSvarLink({ ...base, isCritical: true }).$critical).toBe(true);
    expect(toSvarLink(base).$critical).toBe(false);
  });
});

describe('toSvarLinks', () => {
  it('maps an array of links', () => {
    const links = [base, { ...base, id: 'l2', type: 'SS' as const }];
    const result = toSvarLinks(links);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe('s2s');
  });
});
