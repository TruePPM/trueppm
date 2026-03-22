// Hand-authored domain types not covered by the OpenAPI-generated output.
// Update when API schema changes, then verify against generated src/api/types.ts.

export type HealthState = 'on-track' | 'at-risk' | 'critical' | 'unknown';

export interface Project {
  id: string;
  name: string;
  /** Hex color for the 8px project dot, e.g. '#1C6B3A' */
  colorDot: string;
  healthState: HealthState;
}

export interface ShellStats {
  taskCount: number;
  criticalPathCount: number;
  /** P80 completion date as ISO string */
  monteCarlop80: string | null;
  atRiskCount: number;
  criticalCount: number;
  onlineUsers: number;
  lastSaved: string | null;
}
