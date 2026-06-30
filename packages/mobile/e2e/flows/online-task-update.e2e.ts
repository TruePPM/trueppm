/**
 * Nightly flow 2 (ADR-0026 §Detox E2E): online task update. Open a project →
 * change task status → assert the WebSocket event is received and the UI
 * updates. Skipped until the task detail + WS subscription land.
 */
import { describe, it } from '@jest/globals';

describe.skip('online task update', () => {
  it('reflects a task status change pushed over the WebSocket', () => {
    // Implemented with the task-detail feature + WS subscription.
  });
});
