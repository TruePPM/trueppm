/**
 * Nightly flow 4 (ADR-0026 §Detox E2E): Schedule view read on phone. Load a
 * project with 100 tasks → scroll the Schedule view → assert no crash, critical
 * path visible, dependency arrows render. Skipped until the React Native Skia
 * canvas renderer lands.
 */
import { describe, it } from '@jest/globals';

describe.skip('schedule view read', () => {
  it('renders a 100-task critical path without crashing', () => {
    // Implemented with the read-only canvas Schedule view (RN Skia).
  });
});
