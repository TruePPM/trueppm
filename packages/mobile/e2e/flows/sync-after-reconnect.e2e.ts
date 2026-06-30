/**
 * Nightly flow 3 (ADR-0026 §Detox E2E): sync after reconnect. Stale 24h cache →
 * reconnect → assert server data pulled, local changes pushed, no duplicates,
 * no lost writes. Skipped until the WatermelonDB sync engine (#41) lands.
 */
import { describe, it } from '@jest/globals';

describe.skip('sync after reconnect', () => {
  it('reconciles a stale cache without duplicates or lost writes', () => {
    // Implemented with the WatermelonDB pull/push engine (#41).
  });
});
