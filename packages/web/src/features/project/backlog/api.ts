/**
 * API boundary for the product backlog (ADR-0105). Maps the grooming endpoint's
 * snake_case payload into the UI {@link ProductBacklog} shape, reusing the shared
 * `mapTask` so stories/epics carry the full canonical Task surface.
 */

import { apiClient } from '@/api/client';
import { mapTask, type ApiTask } from '@/hooks/useScheduleTasks';
import type { PrioritizationModel } from '@/types';
import type { EpicGroup, GroomingHealth, ProductBacklog } from './types';

interface ApiEpicGroup {
  epic: ApiTask;
  stories: ApiTask[];
  rollup: { story_count: number; points_total: number; points_done: number };
}

interface ApiProductBacklog {
  epics: ApiEpicGroup[];
  ungrouped: ApiTask[];
  health: {
    dor_pct: number;
    ready_count: number;
    ready_points: number;
    capacity_points: number | null;
    unestimated: number;
    ac_met: number;
    ac_total: number;
    story_count: number;
  };
  scoring: { model: PrioritizationModel };
}

function mapHealth(h: ApiProductBacklog['health']): GroomingHealth {
  return {
    dorPct: h.dor_pct,
    readyCount: h.ready_count,
    readyPoints: h.ready_points,
    capacityPoints: h.capacity_points,
    unestimated: h.unestimated,
    acMet: h.ac_met,
    acTotal: h.ac_total,
    storyCount: h.story_count,
  };
}

function mapEpicGroup(g: ApiEpicGroup): EpicGroup {
  return {
    epic: mapTask(g.epic),
    stories: g.stories.map(mapTask),
    rollup: {
      storyCount: g.rollup.story_count,
      pointsTotal: g.rollup.points_total,
      pointsDone: g.rollup.points_done,
    },
  };
}

export function fromApiProductBacklog(raw: ApiProductBacklog): ProductBacklog {
  return {
    epics: raw.epics.map(mapEpicGroup),
    ungrouped: raw.ungrouped.map(mapTask),
    health: mapHealth(raw.health),
    scoring: { model: raw.scoring.model },
  };
}

export async function fetchProductBacklog(projectId: string): Promise<ProductBacklog> {
  const res = await apiClient.get<ApiProductBacklog>(`/projects/${projectId}/product-backlog/`);
  return fromApiProductBacklog(res.data);
}

export async function postAutoRank(projectId: string): Promise<{ reranked: number }> {
  const res = await apiClient.post<{ reranked: number; model: PrioritizationModel }>(
    `/projects/${projectId}/product-backlog/auto-rank/`,
  );
  return { reranked: res.data.reranked };
}

export async function patchTaskDor(taskId: string, dor: 'ready' | 'refine'): Promise<void> {
  await apiClient.patch(`/tasks/${taskId}/`, { dor });
}

export async function postSplitStory(taskId: string, name?: string): Promise<void> {
  await apiClient.post(`/tasks/${taskId}/split/`, name ? { name } : {});
}
