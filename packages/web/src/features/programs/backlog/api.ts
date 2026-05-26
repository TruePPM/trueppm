/**
 * Boundary mapping between the `BacklogItem` REST serializer (#737, snake_case,
 * lowercase status enum) and the camelCase UI types. Isolated here so the rest
 * of the feature never sees the wire shape.
 */

import type { BacklogItem, BacklogItemStatus, BacklogItemType, MemberProject } from './types';

/** Raw `BacklogItemSerializer` payload. */
export interface ApiBacklogItem {
  id: string;
  server_version: number;
  program: string;
  title: string;
  description: string;
  item_type: BacklogItemType;
  status: 'proposed' | 'pulled' | 'archived';
  tags: string[];
  priority_rank: number;
  story_points: number | null;
  pulled_task: string | null;
  pulled_at: string | null;
  pulled_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_TO_UI: Record<ApiBacklogItem['status'], BacklogItemStatus> = {
  proposed: 'PROPOSED',
  pulled: 'PULLED',
  archived: 'ARCHIVED',
};

const STATUS_TO_API: Record<BacklogItemStatus, ApiBacklogItem['status']> = {
  PROPOSED: 'proposed',
  PULLED: 'pulled',
  ARCHIVED: 'archived',
};

export function fromApiItem(raw: ApiBacklogItem): BacklogItem {
  return {
    id: raw.id,
    programId: raw.program,
    title: raw.title,
    description: raw.description || undefined,
    itemType: raw.item_type,
    status: STATUS_TO_UI[raw.status],
    tags: raw.tags ?? [],
    priorityRank: raw.priority_rank,
    storyPoints: raw.story_points,
    serverVersion: raw.server_version,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    pulledTo: raw.pulled_task
      ? { taskId: raw.pulled_task, at: raw.pulled_at ?? raw.updated_at }
      : undefined,
  };
}

export interface CreateItemPayload {
  title: string;
  item_type: BacklogItemType;
  description?: string;
  tags: string[];
}

/** PATCH body — only the writable fields the UI can edit, in API shape. */
export function toPatchPayload(patch: Partial<BacklogItem>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.description !== undefined) body.description = patch.description ?? '';
  if (patch.itemType !== undefined) body.item_type = patch.itemType;
  if (patch.status !== undefined) body.status = STATUS_TO_API[patch.status];
  if (patch.tags !== undefined) body.tags = patch.tags;
  if (patch.priorityRank !== undefined) body.priority_rank = patch.priorityRank;
  return body;
}

/** Map a program project (from `useProgramProjects`) into a pull target. */
export function toMemberProject(project: {
  id: string;
  name: string;
  colorDot?: string;
}): MemberProject {
  return { id: project.id, name: project.name, color: project.colorDot };
}
