import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let content = 500;
vi.mock('../toolbar/toolbarLadder', async (orig) => ({
  ...(await orig<typeof import('../toolbar/toolbarLadder')>()),
  measureToolbarContent: () => content,
}));

import { useLadderFit } from './useLadderFit';

const LADDER = [{ estimate: 100 }, { estimate: 100 }];

describe('useLadderFit', () => {
  it('re-fits when the inventory signature changes though the bar box does not (rule 343)', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 600 });
    const ref = { current: el };
    content = 500;
    const { result, rerender } = renderHook(({ sig }) => useLadderFit(ref, LADDER, sig), {
      initialProps: { sig: 'a' },
    });
    expect(result.current).toBe(0);
    // The content grows (e.g. the legend gains its Baseline entry): same box.
    content = 700;
    rerender({ sig: 'b' });
    expect(result.current).toBeGreaterThan(0);
  });
});
