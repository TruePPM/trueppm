import { afterEach, describe, expect, it, vi } from 'vitest';
import { fullJitterDelay } from './reconnectBackoff';

describe('fullJitterDelay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('spans the whole window from 0 up to just under the bound', () => {
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(0);
    expect(fullJitterDelay(1_000)).toBe(0);
    rnd.mockReturnValue(0.5);
    expect(fullJitterDelay(1_000)).toBe(500);
    rnd.mockReturnValue(0.999999);
    expect(fullJitterDelay(1_000)).toBeLessThan(1_000);
  });

  it('the window grows with the exponential step', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(fullJitterDelay(1_000)).toBe(500);
    expect(fullJitterDelay(2_000)).toBe(1_000);
    expect(fullJitterDelay(4_000)).toBe(2_000);
  });
});
