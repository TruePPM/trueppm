/**
 * UI types for the Product-Owner backlog (ADR-0105, Wave 2).
 *
 * The grooming endpoint (`GET /projects/{id}/product-backlog/`) returns epics with
 * nested stories plus a grooming-health summary. Stories/epics are the canonical
 * {@link Task} shape (mapped via the shared `mapTask`), so components reuse Task
 * fields (taskType, epic, dor, acceptanceCriteria, score, acMet/acTotal, …).
 */

import type { PrioritizationModel, Task } from '@/types';

export interface EpicGroup {
  epic: Task;
  stories: Task[];
  rollup: {
    storyCount: number;
    pointsTotal: number;
    pointsDone: number;
  };
}

export interface GroomingHealth {
  /** % of backlog stories at dor=ready. */
  dorPct: number;
  readyCount: number;
  /** Sum of story points across ready stories. */
  readyPoints: number;
  /** Active sprint's capacity_points, or null when there is no active sprint. */
  capacityPoints: number | null;
  unestimated: number;
  acMet: number;
  acTotal: number;
  storyCount: number;
}

export interface ProductBacklog {
  epics: EpicGroup[];
  /** Stories with no epic. */
  ungrouped: Task[];
  health: GroomingHealth;
  scoring: {
    model: PrioritizationModel;
  };
}
