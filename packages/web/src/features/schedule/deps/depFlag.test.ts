import { describe, expect, it } from 'vitest';
import { depFlag, describeLinksCell, type DepEdgeSummary } from './depFlag';

const fs = (lag = 0): DepEdgeSummary => ({ type: 'FS', lag });
const ss = (lag = 0): DepEdgeSummary => ({ type: 'SS', lag });
const ff = (lag = 0): DepEdgeSummary => ({ type: 'FF', lag });
const sf = (lag = 0): DepEdgeSummary => ({ type: 'SF', lag });

describe('depFlag — the two forms the design names (#3023)', () => {
  it('states FS×N when the links AGREE on type — a chain', () => {
    expect(depFlag([fs(), fs()], 'predecessor')?.label).toBe('FS×2');
    expect(depFlag([ss(), ss(), ss()], 'predecessor')?.label).toBe('SS×3');
  });

  it('states FS·SS when the links DIFFER — an overlap, not a chain', () => {
    expect(depFlag([fs(), ss()], 'predecessor')?.label).toBe('FS·SS');
  });

  it('is what a count could not be: two FS links and an FS+SS pair read differently', () => {
    // The whole argument for the flag. Both rows have two predecessors; the
    // shipped `←2` chip said the same thing about both.
    expect(depFlag([fs(), fs()], 'predecessor')?.label).not.toBe(
      depFlag([fs(), ss()], 'predecessor')?.label,
    );
  });

  it('drops the ×1 on a single link — "FS", not "FS×1"', () => {
    expect(depFlag([fs()], 'predecessor')?.label).toBe('FS');
  });

  it('reads the same regardless of the order the links arrived in', () => {
    expect(depFlag([ss(), fs()], 'predecessor')?.label).toBe(
      depFlag([fs(), ss()], 'predecessor')?.label,
    );
    expect(depFlag([sf(), ff()], 'successor')?.label).toBe('FF·SF');
  });

  it('collapses THREE OR MORE distinct types to Mixed×N — counting LINKS, not types', () => {
    // The design does not specify this case. `FS·SS·FF` grows with the graph and
    // stops being scannable in a 76px cell; `Mixed` says "go look" and the
    // tooltip carries the detail.
    expect(depFlag([fs(), ss(), ff()], 'predecessor')?.label).toBe('Mixed×3');
    expect(depFlag([fs(), fs(), ss(), ff(), sf()], 'predecessor')?.label).toBe('Mixed×5');
  });

  it('returns null for zero links — "no links" is not a shape', () => {
    expect(depFlag([], 'predecessor')).toBeNull();
    expect(depFlag([], 'successor')).toBeNull();
  });
});

describe('depFlag — the tooltip carries the detail the label cannot', () => {
  it('names the type in full, singular for one', () => {
    expect(depFlag([fs()], 'predecessor')?.detail).toBe('1 predecessor: Finish-to-Start');
  });

  it('collapses identical links rather than repeating the phrase', () => {
    expect(depFlag([fs(), fs()], 'predecessor')?.detail).toBe(
      '2 predecessors: 2 × Finish-to-Start',
    );
  });

  it('lists differing types in canonical order', () => {
    expect(depFlag([ss(), fs()], 'successor')?.detail).toBe(
      '2 successors: Finish-to-Start, Start-to-Start',
    );
  });

  it('states lag, signed, and does NOT collapse two links that differ only in lag', () => {
    expect(depFlag([fs(2)], 'predecessor')?.detail).toBe('1 predecessor: Finish-to-Start +2d');
    expect(depFlag([fs(-1)], 'predecessor')?.detail).toBe('1 predecessor: Finish-to-Start -1d');
    // FS+0 and FS+5 are two different links; collapsing them to "2 × FS" would
    // state something false.
    expect(depFlag([fs(0), fs(5)], 'predecessor')?.detail).toBe(
      '2 predecessors: Finish-to-Start, Finish-to-Start +5d',
    );
  });

  it('spells out every type name', () => {
    expect(depFlag([sf()], 'predecessor')?.detail).toContain('Start-to-Finish');
    expect(depFlag([ff()], 'predecessor')?.detail).toContain('Finish-to-Finish');
  });
});

describe('depFlag — criticality is stated in WORDS, not left to the tint', () => {
  it('names the critical path in the detail, so it survives into the tooltip and label', () => {
    // WCAG 1.4.1: the red chip is no carrier at all for a screen-reader user or
    // anyone with a red deficiency, and it is the one fact that changes what
    // the reader does next.
    expect(depFlag([fs()], 'predecessor', true)?.detail).toBe(
      '1 predecessor: Finish-to-Start — on the critical path',
    );
  });

  it('says nothing extra when the chain is not critical', () => {
    expect(depFlag([fs()], 'predecessor', false)?.detail).toBe('1 predecessor: Finish-to-Start');
    expect(depFlag([fs()], 'predecessor')?.detail).toBe('1 predecessor: Finish-to-Start');
  });
});

describe('depFlag — a hub row does not produce a multi-kilobyte sentence', () => {
  it('caps the group list and says how many it did not name', () => {
    const edges: DepEdgeSummary[] = [fs(1), fs(2), fs(3), fs(4), fs(5), fs(6)];
    const detail = depFlag(edges, 'predecessor')?.detail ?? '';
    expect(detail).toBe(
      '6 predecessors: Finish-to-Start +1d, Finish-to-Start +2d, Finish-to-Start +3d, ' +
        'Finish-to-Start +4d, and 2 more',
    );
    expect(detail.length).toBeLessThan(200);
  });
});

describe('depFlag — a type the client does not recognize', () => {
  it('echoes the code rather than claiming "Mixed" about a single link', () => {
    // `dep_type` is cast, not validated, on the way in. Filtering the canonical
    // order alone would leave ZERO distinct types here and fall through to the
    // Mixed arm — `Mixed×1` is a confident wrong statement about one link.
    const odd = [{ type: 'XX' as unknown as DepEdgeSummary['type'], lag: 0 }];
    expect(depFlag(odd, 'predecessor')?.label).toBe('XX');
    expect(depFlag(odd, 'predecessor')?.detail).toBe('1 predecessor: XX');
    expect(depFlag([...odd, fs()], 'predecessor')?.label).toBe('FS·XX');
  });
});

describe('describeLinksCell — one announcement per cell', () => {
  const flag = (edges: DepEdgeSummary[], dir: 'predecessor' | 'successor') =>
    depFlag(edges, dir);

  it('names the row and both directions', () => {
    expect(
      describeLinksCell(flag([fs(), fs()], 'predecessor'), flag([ss()], 'successor'), 'Pour slab'),
    ).toBe('Links for Pour slab — 2 predecessors: 2 × Finish-to-Start; 1 successor: Start-to-Start');
  });

  it('omits a direction that has no edges rather than saying "0"', () => {
    expect(describeLinksCell(null, flag([fs()], 'successor'), 'Pour slab')).toBe(
      'Links for Pour slab — 1 successor: Finish-to-Start',
    );
  });

  it('states the empty case explicitly — an unlabeled cell is unattributable', () => {
    expect(describeLinksCell(null, null, 'Pour slab')).toBe('Links: none for Pour slab');
  });
});
