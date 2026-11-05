import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDemoSessionMarker, hasDemoSessionMarker, markDemoSession } from './demoMarker';

describe('demoMarker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDemoSessionMarker();
  });

  it('round-trips and clears', () => {
    expect(hasDemoSessionMarker()).toBe(false);
    markDemoSession();
    expect(hasDemoSessionMarker()).toBe(true);
    clearDemoSessionMarker();
    expect(hasDemoSessionMarker()).toBe(false);
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => markDemoSession()).not.toThrow();
    expect(() => clearDemoSessionMarker()).not.toThrow();
    expect(hasDemoSessionMarker()).toBe(false);
  });
});
