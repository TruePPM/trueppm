/**
 * Public barrel for the canvas Gantt engine.
 *
 * Import everything through this file — do not import directly from
 * engine sub-modules outside of the engine/ directory itself.
 */

export type { GanttEngine, GanttEngineEventMap } from './GanttEngine';
export type { GanttScaleData, ZoomLevel, ZoomConfig, QuarterMode, FiscalConfig } from './GanttScaleData';
export {
  ZOOM_CONFIGS,
  CALENDAR_QUARTERS,
  buildScaleData,
  dateToLeft,
  leftToDate,
  parseUTCDate,
} from './GanttScaleData';
export { GanttEngineStub } from './GanttEngineStub';
export { GanttEngineImpl } from './GanttEngineImpl';
export type { GanttEngineImplOptions } from './GanttEngineImpl';
