import { describe, it, expect } from 'vitest';
import { isTabVisibleForMethodology } from './methodologyTabs';

// Encodes the ADR-0041 visibility matrix as a single source of truth.
// Amended by ADR-0053: `wbs` and `list` consolidated into `grid`, visible in
// all three methodologies. Outline mode (formerly WBS) is the default for
// WATERFALL/HYBRID; Flat mode is the default for AGILE.
const MATRIX: Record<'WATERFALL' | 'AGILE' | 'HYBRID', Record<string, boolean>> = {
  WATERFALL: {
    overview: true,
    board: true,
    sprints: false,
    schedule: true,
    grid: true,
    calendar: true,
    resources: true,
    risk: true,
  },
  AGILE: {
    overview: true,
    board: true,
    sprints: true,
    schedule: false,
    grid: true,
    calendar: false,
    resources: true,
    risk: true,
  },
  HYBRID: {
    overview: true,
    board: true,
    sprints: true,
    schedule: true,
    grid: true,
    calendar: true,
    resources: true,
    risk: true,
  },
};

describe('isTabVisibleForMethodology', () => {
  for (const [methodology, expectations] of Object.entries(MATRIX) as Array<
    [keyof typeof MATRIX, Record<string, boolean>]
  >) {
    for (const [view, expected] of Object.entries(expectations)) {
      it(`${methodology}: ${view} is ${expected ? 'visible' : 'hidden'}`, () => {
        expect(isTabVisibleForMethodology(view, methodology)).toBe(expected);
      });
    }
  }

  it('treats unknown views as visible (no false hides)', () => {
    // A future tab that hasn't been added to the matrix should default to
    // visible — methodology preset is a hide-list, not an allow-list.
    expect(isTabVisibleForMethodology('unknown-future-tab', 'WATERFALL')).toBe(true);
    expect(isTabVisibleForMethodology('unknown-future-tab', 'AGILE')).toBe(true);
    expect(isTabVisibleForMethodology('unknown-future-tab', 'HYBRID')).toBe(true);
  });
});
