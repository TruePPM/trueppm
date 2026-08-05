export { expectNoA11yViolations, type A11yScanOptions } from './a11y';
export { setupAuth, type SetupAuthOptions } from './auth';
export { openCommandPalette, paletteDialog, paletteSearch } from './command-palette';
export {
  setupTaskStore,
  type TaskRow,
  type TaskStoreHandle,
  type TaskStoreOptions,
} from './task-store';
export { delayRoute, COLD_LOAD_DELAY_MS } from './cold-load';
export {
  setupApiMocks,
  setupCatchAll,
  setupPinned,
  type PinnedFixture,
  type ApiMockOptions,
  type ProjectFixture,
  type UserFixture,
  type OverviewFixture,
  type StatusSummaryFixture,
  type BoardColumnConfig,
} from './api-mocks';
