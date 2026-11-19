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
  WorkingTimeConfig,
} from './GanttScaleData';
export {
  ZOOM_CONFIGS,
  CALENDAR_QUARTERS,
  MON_FRI_WORKING_TIME,
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
  dateToRight,
  milestoneX,
  dragDropStartIso,
  leftToDate,
  parseUTCDate,
} from './GanttScaleData';
export type { BaselineDates, ChartRenderOptions, TaskNamePlacement } from './GanttRenderer';
export { GanttEngineStub } from './GanttEngineStub';
export { GanttEngineImpl } from './GanttEngineImpl';
export type { GanttEngineImplOptions } from './GanttEngineImpl';
