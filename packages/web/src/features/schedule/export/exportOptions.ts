/**
 * Export-options model + pure read-out helpers for the schedule-export dialog
 * (issue 1438, ADR-0233). Kept React-free so the option shape, the render-time
 * estimate, and the file-card formatters are unit-testable without a DOM.
 */
import type { SchedulePaper } from './exportSchedulePdf';

/** Layout choice. `report` (Layout B, the 3-page report) is issue 1439 — disabled. */
export type ExportLayoutChoice = 'gantt' | 'report';
/** Timeline range: whole schedule, or the currently-scrolled viewport window. */
export type ExportRangeChoice = 'full' | 'visible';

export interface ScheduleExportOptions {
  layout: ExportLayoutChoice;
  paper: SchedulePaper;
  range: ExportRangeChoice;
  /** Render FS dependency arrows. */
  includeArrows: boolean;
  /** Include non-critical rows. Off ⇒ chart only the critical-path chain. */
  includeNonCritical: boolean;
  /** Render the critical-path summary box (the ordered driving chain). */
  includeCpSummary: boolean;
  /** Render the Owner column (initials). */
  includeOwnerColumn: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ScheduleExportOptions = {
  layout: 'gantt',
  paper: 'letter',
  range: 'full',
  includeArrows: true,
  includeNonCritical: false,
  includeCpSummary: true,
  includeOwnerColumn: true,
};

/**
 * Coarse render-time estimate (ms) for the footer read-out — a heuristic, not a
 * measurement: a fixed floor absorbs the fixed rasterize/serialize cost, plus a
 * per-activity slice. Deliberately conservative so it rarely under-promises.
 */
export function estimateRenderMs(activityCount: number): number {
  return Math.max(400, Math.round(Math.max(0, activityCount) * 14));
}

/** "~1s" / "~3s" label from the ms estimate. */
export function formatEstimate(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `~${seconds}s`;
}

/** Human byte size for the success file card: `84 KB` / `1.2 MB`. 0 → em dash. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1 page" / "3 pages" — pluralized page count for the file card. */
export function formatPageCount(n: number): string {
  return `${n} ${n === 1 ? 'page' : 'pages'}`;
}
