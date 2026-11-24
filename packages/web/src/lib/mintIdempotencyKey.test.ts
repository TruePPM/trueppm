import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintIdempotencyKey } from './mintIdempotencyKey';

describe('mintIdempotencyKey', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
    expect(mintIdempotencyKey()).toBe('uuid-1');
  });

  it('falls back to a unique string when randomUUID is undefined', () => {
    vi.stubGlobal('crypto', {});
    const a = mintIdempotencyKey();
    const b = mintIdempotencyKey();
    expect(a).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});
