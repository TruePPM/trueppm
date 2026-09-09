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
export { setupScheduleDisplayOptions } from './schedule-display-options';
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
export {
  installSchemaGuard,
  validateBody,
  enforcedViolations,
  unwaivedViolations,
  decodeFulfillBody,
  type Violation,
  type ViolationRule,
} from './schema-guard';
export type { SchemaGuardWaiver } from './schema-guard-waivers';
export {
  resolveResponseSchema,
  allOperationKeys,
  isFreeForm,
  deref,
  type SchemaNode,
} from './openapi-schema';
export { useFullToolbar, FULL_TOOLBAR_VIEWPORT } from './toolbar-width';
export { modeChip, toggleAuthorMode, openScheduleCheatsheet } from './schedule-mode';
