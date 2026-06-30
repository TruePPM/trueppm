/**
 * Nightly flow 5 (ADR-0026 §Detox E2E): auth refresh. Login → receive tokens →
 * background the app for 1h → foreground → assert silent token refresh and a
 * surviving session. Skipped until the auth + JWT refresh flow lands.
 */
import { describe, it } from '@jest/globals';

describe.skip('auth token refresh', () => {
  it('silently refreshes the session after a long background', () => {
    // Implemented with the auth feature (expo-secure-store + refresh flow).
  });
});
