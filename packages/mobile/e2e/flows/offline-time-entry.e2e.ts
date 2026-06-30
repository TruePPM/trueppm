/**
 * Nightly flow 1 (ADR-0026 §Detox E2E): offline time entry — Priya's core flow.
 * Airplane mode → log 2h against a task → reconnect → assert the time entry
 * reaches the server. Skipped until the time-entry write path + offline outbox
 * (#41) land; required nightly on Android in 0.4 once an emulator runner exists.
 */
import { describe, it } from '@jest/globals';

describe.skip('offline time entry', () => {
  it('queues a time entry offline and syncs it on reconnect', () => {
    // Implemented with the time-entry feature + offline outbox (#41).
  });
});
