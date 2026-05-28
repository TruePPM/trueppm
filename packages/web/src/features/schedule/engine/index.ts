/**
 * Public barrel for the canvas Gantt engine.
 *
 * Import everything through this file — do not import directly from
 * engine sub-modules outside of the engine/ directory itself.
 */

export type { GanttEngine, GanttEngineEventMap } from './GanttEngine';
export type {
  GanttScaleData,
  ZoomLevel,
  ZoomConfig,
  QuarterMode,
  FiscalConfig,
  HeaderTier,
} from './GanttScaleData';
export {
  ZOOM_CONFIGS,
  CALENDAR_QUARTERS,
  MIN_PX_PER_DAY,
  MAX_PX_PER_DAY,
  ZOOM_STEP_FACTOR,
  ZOOM_WHEEL_FACTOR,
  HEADER_TIERS,
  buildScaleData,
  buildScaleDataFromPxPerDay,
  clampPxPerDay,
  deriveTier,
  headerTierForPxPerDay,
  headerUnitsForPxPerDay,
  dateToLeft,
  leftToDate,
  parseUTCDate,
} from './GanttScaleData';
export { GanttEngineStub } from './GanttEngineStub';
export { GanttEngineImpl } from './GanttEngineImpl';
export type { GanttEngineImplOptions } from './GanttEngineImpl';
