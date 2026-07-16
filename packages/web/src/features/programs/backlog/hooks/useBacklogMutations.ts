/**
 * Write layer for the program backlog (ADR-0069 API, #737). Each mutation
 * calls the REST endpoint and then reconciles the cached list through
 * `patchBacklogCache`, so the UI updates without a refetch. (The pull action
 * is optimistic and lives in `usePullItem`.)
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { fromApiItem, toPatchPayload, type ApiBacklogItem } from '../api';
import type { BacklogItem, BacklogItemType } from '../types';
import { patchBacklogCache } from './useBacklogItems';

export interface CreateBacklogItemInput {
  title: string;
  itemType: BacklogItemType;
  description?: string;
  tags: string[];
  storyPoints?: number | null;
}

export interface BacklogMutations {
  createItem: (input: CreateBacklogItemInput) => Promise<BacklogItem>;
  updateItem: (id: string, patch: Partial<BacklogItem>) => Promise<void>;
  archiveItem: (id: string) => Promise<void>;
  restoreItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  reorderItem: (id: string, newRank: number) => Promise<void>;
  isPending: boolean;
}

export function useBacklogMutations(programId: string | undefined): BacklogMutations {
  const queryClient = useQueryClient();
  const base = `/programs/${programId}/backlog-items/`;

  const upsertInCache = (item: BacklogItem) =>
    patchBacklogCache(queryClient, programId, (items) => {
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx === -1) return [...items, item];
      const next = [...items];
      next[idx] = item;
      return next;
    });

  const create = useMutation({
    mutationFn: async (input: CreateBacklogItemInput): Promise<BacklogItem> => {
      const res = await apiClient.post<ApiBacklogItem>(base, {
        title: input.title.trim(),
        item_type: input.itemType,
        description: input.description?.trim() ?? '',
        tags: input.tags,
        story_points: input.storyPoints ?? null,
      });
      const item = fromApiItem(res.data);
      upsertInCache(item);
      return item;
    },
  });

  const patch = useMutation({
    mutationFn: async ({ id, patch: body }: { id: string; patch: Partial<BacklogItem> }) => {
      const res = await apiClient.patch<ApiBacklogItem>(`${base}${id}/`, toPatchPayload(body));
      upsertInCache(fromApiItem(res.data));
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`${base}${id}/`);
      patchBacklogCache(queryClient, programId, (items) => items.filter((i) => i.id !== id));
    },
  });

  return {
    createItem: (input) => create.mutateAsync(input),
    updateItem: (id, body) => patch.mutateAsync({ id, patch: body }),
    archiveItem: (id) => patch.mutateAsync({ id, patch: { status: 'ARCHIVED' } }),
    restoreItem: (id) => patch.mutateAsync({ id, patch: { status: 'PROPOSED' } }),
    deleteItem: (id) => remove.mutateAsync(id),
    reorderItem: (id, newRank) => patch.mutateAsync({ id, patch: { priorityRank: newRank } }),
    isPending: create.isPending || patch.isPending || remove.isPending,
  };
}
