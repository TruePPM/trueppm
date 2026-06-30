// Detox + jest lifecycle hooks (scaffolded — not run in CI yet). The Detox
// follow-up adds `detox`, `jest`, and `@types/jest`/`@types/detox` to the
// package; until then this file is inert scaffold and is excluded from the
// mobile:typecheck / mobile:lint scope (those target src/ only, mirroring web's
// `eslint src/`).
import { beforeAll, afterAll, beforeEach } from '@jest/globals';
import { device } from 'detox';

beforeAll(async () => {
  await device.launchApp({ newInstance: true });
});

beforeEach(async () => {
  await device.reloadReactNative();
});

afterAll(async () => {
  await device.terminateApp();
});
