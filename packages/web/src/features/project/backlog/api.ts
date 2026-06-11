/**
 * API boundary for the product backlog (ADR-0105). Maps the grooming endpoint's
 * snake_case payload into the UI {@link ProductBacklog} shape, reusing the shared
 * `mapTask` so stories/epics carry the full canonical Task surface.
 */

import { apiClient } from '@/api/client';
import { mapTask, type ApiTask } from '@/hooks/useScheduleTasks';
import type { AcceptanceCriterion, DorState, PrioritizationModel, TaskType } from '@/types';
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

export async function patchTaskDor(taskId: string, dor: DorState): Promise<void> {
  await apiClient.patch(`/tasks/${taskId}/`, { dor });
}

/**
 * The scalar story fields the grooming drawer (#1043) edits as one batched PATCH.
 * camelCase here; mapped to the serializer's snake_case in {@link patchStory}.
 * `parentEpic: null` clears the epic link (ungroups the story).
 */
export interface StoryScalarPatch {
  name?: string;
  /** Long-form description — maps to the API's `notes` field. */
  notes?: string;
  type?: TaskType;
  parentEpic?: string | null;
  storyPoints?: number | null;
  dor?: DorState;
  businessValue?: number | null;
  timeCriticality?: number | null;
  riskReduction?: number | null;
  jobSize?: number | null;
  reach?: number | null;
  impact?: number | null;
  confidence?: number | null;
  effort?: number | null;
  value?: number | null;
  effortEstimate?: number | null;
}

const STORY_FIELD_TO_WIRE: Record<keyof StoryScalarPatch, string> = {
  name: 'name',
  notes: 'notes',
  type: 'type',
  parentEpic: 'parent_epic',
  storyPoints: 'story_points',
  dor: 'dor',
  businessValue: 'business_value',
  timeCriticality: 'time_criticality',
  riskReduction: 'risk_reduction',
  jobSize: 'job_size',
  reach: 'reach',
  impact: 'impact',
  confidence: 'confidence',
  effort: 'effort',
  value: 'value',
  effortEstimate: 'effort_estimate',
};

/**
 * Batch-PATCH the editable scalar fields of a backlog story (#1043). Only the
 * keys present on `patch` are sent, so a partial edit never clobbers untouched
 * fields. Structural fields (type, parent_epic, scoring inputs) are server-gated
 * to backlog managers (Admin+ or PO facet) — a 403 propagates to the caller.
 */
export async function patchStory(taskId: string, patch: StoryScalarPatch): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof StoryScalarPatch)[]) {
    if (patch[key] !== undefined) body[STORY_FIELD_TO_WIRE[key]] = patch[key];
  }
  await apiClient.patch(`/tasks/${taskId}/`, body);
}

// ── Acceptance-criteria CRUD (ADR-0105 §2, flat collection) ────────────────────
// The criteria live nested-read inside each task, but mutate through their own
// flat endpoint with a `task` foreign key. Member+ writes (the team ticks the
// checklist during review), distinct from the Admin+/PO structural gate above.

interface ApiAcceptanceCriterion {
  id: string;
  text: string;
  given?: string;
  when?: string;
  then?: string;
  met: boolean;
  position: number;
  met_by_name?: string | null;
  met_at?: string | null;
}

function mapCriterion(c: ApiAcceptanceCriterion): AcceptanceCriterion {
  return {
    id: c.id,
    text: c.text,
    given: c.given,
    when: c.when,
    then: c.then,
    met: c.met,
    position: c.position,
    metByName: c.met_by_name ?? null,
    metAt: c.met_at ?? null,
  };
}

export async function createCriterion(
  taskId: string,
  text: string,
  position: number,
): Promise<AcceptanceCriterion> {
  const res = await apiClient.post<ApiAcceptanceCriterion>('/acceptance-criteria/', {
    task: taskId,
    text,
    position,
  });
  return mapCriterion(res.data);
}

export async function updateCriterion(
  criterionId: string,
  patch: { text?: string; met?: boolean; position?: number },
): Promise<AcceptanceCriterion> {
  const res = await apiClient.patch<ApiAcceptanceCriterion>(
    `/acceptance-criteria/${criterionId}/`,
    patch,
  );
  return mapCriterion(res.data);
}

export async function deleteCriterion(criterionId: string): Promise<void> {
  await apiClient.delete(`/acceptance-criteria/${criterionId}/`);
}

export async function postSplitStory(taskId: string, name?: string): Promise<void> {
  await apiClient.post(`/tasks/${taskId}/split/`, name ? { name } : {});
}

/** One {id, server_version} entry of a reorder payload (ADR-0110). */
export interface ReorderEntry {
  id: string;
  server_version: number;
}

/**
 * Persist a manual drag reorder of the backlog (ADR-0110, #494). `stories` is the
 * COMPLETE current backlog in target priority order; the server writes dense
 * priority_rank 1..N and returns the count of rows whose rank changed. A 409 (stale
 * snapshot — another PO changed the backlog) propagates as an axios error for the caller
 * to handle by refetching and replaying the drag.
 */
export async function postReorderBacklog(
  projectId: string,
  stories: ReorderEntry[],
): Promise<{ updated: number }> {
  const res = await apiClient.post<{ updated: number }>(
    `/projects/${projectId}/product-backlog/reorder/`,
    { stories },
  );
  return { updated: res.data.updated };
}

/**
 * Quick-add a title-only backlog story (#921). Posts status=BACKLOG / type=story; the
 * server leaves priority_rank null so the story sorts to the bottom of the backlog.
 */
export async function createBacklogStory(projectId: string, name: string): Promise<void> {
  await apiClient.post('/tasks/', {
    project: projectId,
    name,
    status: 'BACKLOG',
    type: 'story',
  });
}
