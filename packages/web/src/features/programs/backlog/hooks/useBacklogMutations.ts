/**
 * Fixture-backed write layer for the program backlog.
 *
 * Each mutation edits the TanStack cache through `patchBacklogCache` and
 * resolves after a short simulated latency, so the UI exercises real loading
 * and optimistic paths without a server. When ADR-0069's endpoints land, the
 * `mutationFn` bodies call the API and the cache writes move into `onSuccess`
 * / `onMutate` — callers are unaffected.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nextPriorityRank } from '../filter';
import type { BacklogItem, BacklogItemType } from '../types';
import { patchBacklogCache, readBacklogCache } from './useBacklogItems';

const WRITE_LATENCY_MS = 240;

function settle(ms = WRITE_LATENCY_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Next sequential BI-0NN id from the current cache. */
function nextItemId(items: BacklogItem[]): string {
  const max = items.reduce((acc, item) => {
    const n = Number.parseInt(item.id.replace(/\D/g, ''), 10);
    return Number.isNaN(n) ? acc : Math.max(acc, n);
  }, 0);
  return `BI-${String(max + 1).padStart(3, '0')}`;
}

export interface CreateBacklogItemInput {
  title: string;
  itemType: BacklogItemType;
  description?: string;
  assigneeId?: string;
  tags: string[];
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

  const create = useMutation({
    mutationFn: async (input: CreateBacklogItemInput): Promise<BacklogItem> => {
      await settle();
      const existing = readBacklogCache(queryClient, programId) ?? [];
      const now = new Date().toISOString();
      const item: BacklogItem = {
        id: nextItemId(existing),
        programId: programId ?? '',
        title: input.title.trim(),
        description: input.description?.trim() || undefined,
        itemType: input.itemType,
        status: 'PROPOSED',
        tags: input.tags,
        priorityRank: nextPriorityRank(existing),
        assigneeId: input.assigneeId,
        createdAt: now,
        updatedAt: now,
      };
      patchBacklogCache(queryClient, programId, (items) => [...items, item]);
      return item;
    },
  });

  const mutateOne = (patch: (item: BacklogItem) => BacklogItem) => (id: string) => {
    patchBacklogCache(queryClient, programId, (items) =>
      items.map((item) => (item.id === id ? patch(item) : item)),
    );
  };

  const touch =
    (extra: Partial<BacklogItem>) =>
    (item: BacklogItem): BacklogItem => ({
      ...item,
      ...extra,
      updatedAt: new Date().toISOString(),
    });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<BacklogItem> }) => {
      await settle();
      mutateOne(touch(patch))(id);
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      await settle();
      mutateOne(touch({ status: 'ARCHIVED' }))(id);
    },
  });

  const restore = useMutation({
    mutationFn: async (id: string) => {
      await settle();
      mutateOne(touch({ status: 'PROPOSED' }))(id);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await settle();
      patchBacklogCache(queryClient, programId, (items) => items.filter((item) => item.id !== id));
    },
  });

  const reorder = useMutation({
    mutationFn: async ({ id, newRank }: { id: string; newRank: number }) => {
      await settle();
      // Re-stripe ranks 1..N in the new order so gaps stay clean. The backend
      // (#737) re-stripes server-side; this mirrors that for the fixture store.
      patchBacklogCache(queryClient, programId, (items) => {
        const proposed = items
          .filter((i) => i.status === 'PROPOSED')
          .sort((a, b) => a.priorityRank - b.priorityRank);
        const moving = proposed.find((i) => i.id === id);
        if (!moving) return items;
        const without = proposed.filter((i) => i.id !== id);
        const clamped = Math.max(1, Math.min(newRank, without.length + 1));
        without.splice(clamped - 1, 0, moving);
        const rankById = new Map(without.map((i, idx) => [i.id, idx + 1]));
        return items.map((i) =>
          rankById.has(i.id) ? { ...i, priorityRank: rankById.get(i.id)! } : i,
        );
      });
    },
  });

  return {
    createItem: (input) => create.mutateAsync(input),
    updateItem: (id, patch) => update.mutateAsync({ id, patch }),
    archiveItem: (id) => archive.mutateAsync(id),
    restoreItem: (id) => restore.mutateAsync(id),
    deleteItem: (id) => remove.mutateAsync(id),
    reorderItem: (id, newRank) => reorder.mutateAsync({ id, newRank }),
    isPending:
      create.isPending ||
      update.isPending ||
      archive.isPending ||
      restore.isPending ||
      remove.isPending ||
      reorder.isPending,
  };
}
