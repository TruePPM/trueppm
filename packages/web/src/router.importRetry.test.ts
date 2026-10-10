import { describe, expect, it, vi } from 'vitest';
import routerSource from './router.tsx?raw';

// Passthrough spy: the router must hand every route import to withImportRetry
// (ADR-1249 step 5), or a failed chunk skips the retry and reloads at once.
const withImportRetry = vi.hoisted(() => vi.fn(<T>(load: () => Promise<T>) => load));
vi.mock('@/lib/chunkReload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chunkReload')>()),
  withImportRetry,
}));

describe('router route chunks (ADR-1249)', () => {
  it('wraps every lazy route import in withImportRetry', async () => {
    const declared = routerSource.match(/=\s*lazy\(/g)?.length ?? 0;
    await import('./router');
    expect(declared).toBeGreaterThan(40);
    expect(withImportRetry).toHaveBeenCalledTimes(declared);
    for (const [load] of withImportRetry.mock.calls) expect(load).toEqual(expect.any(Function));
  });
});
