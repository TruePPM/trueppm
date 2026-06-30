/**
 * PR-gated launch smoke (ADR-0026 §4) — the ONE backend-free flow.
 *
 * Cold-launches the app and asserts the bottom-tab shell boots to the Tasks
 * surface within the < 2s cold-start budget. No network, no seeded server: it
 * only proves the bare shell boots and navigates. This is the flow wired into
 * the (future) per-PR/nightly Android smoke once an emulator-capable runner
 * exists (issues #29 / #30).
 */
import { by, device, element, expect, waitFor } from 'detox';
import { describe, it, beforeAll } from '@jest/globals';

describe('app launch smoke', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  it('boots to the bottom-tab shell with Tasks selected', async () => {
    // < 2s cold-start gate (Pixel 6 baseline, ADR-0026 performance targets).
    await waitFor(element(by.id('tab-tasks')))
      .toBeVisible()
      .withTimeout(2000);
    await expect(element(by.id('screen-tasks'))).toBeVisible();
  });

  it('navigates to the Time tab', async () => {
    await element(by.id('tab-time')).tap();
    await expect(element(by.id('screen-time'))).toBeVisible();
  });
});
