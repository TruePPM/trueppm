import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { SprintRetroActionItem } from './useSprints';

// ---------------------------------------------------------------------------
// Live multi-writer retro board (#851) + team-health pulse (#923), ADR-0117.
//
// The board stickies and pulse responses are first-class server facts; the
// client renders them and derives no domain values (column ordering,
// fractional `position` resolution, and pulse aggregation are all
// server-computed). Writes go through authenticated REST and fire a
// best-effort `broadcast_board_event` on commit; peers reconcile via the
// retro_item_* WebSocket events handled in useProjectWebSocket.
// ---------------------------------------------------------------------------

/** The three fixed columns for the 0.3 retro board template (ADR-0117 §2). */
export type RetroBoardColumnKey = 'went_well' | 'to_improve' | 'ideas';

export interface RetroBoardColumn {
  key: RetroBoardColumnKey;
  label: string;
}

/** A single live discussion sticky on the retro board (ADR-0117 §1). */
export interface RetroBoardItem {
  id: string;
  retro: string;
  column: RetroBoardColumnKey;
  text: string;
  /** User PK of the author, or null when the author has been removed. */
  author: number | null;
  author_username: string | null;
  /** Fractional index used for ordering within a column (server-resolved). */
  position: number;
  /** Optional DS-token swatch key; presentation only. */
  color: string;
  /** Set once the sticky has been converted into a RetroActionItem (§1). */
  converted_action_item_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetroBoardResponse {
  columns: RetroBoardColumn[];
  items: RetroBoardItem[];
}

/**
 * GET /api/v1/sprints/{id}/retro-board/ — the live sticky board.
 *
 * Returns the fixed column template plus every sticky across all columns.
 * Peers keep this cache fresh through the retro_item_* WebSocket events
 * (useProjectWebSocket), which invalidate this key on any remote mutation.
 */
export function useRetroBoard(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'retro-board'],
    queryFn: async () => {
      const res = await apiClient.get<RetroBoardResponse>(
        `/sprints/${sprintId}/retro-board/`,
      );
      return res.data;
    },
    enabled: !!sprintId,
  });
}

const boardKey = (sprintId: string | null | undefined) =>
  ['sprint', sprintId, 'retro-board'] as const;

/** Snapshot captured in onMutate so onError can roll an optimistic write back. */
interface BoardSnapshot {
  snapshot: RetroBoardResponse | undefined;
}

export interface CreateBoardItemInput {
  column: RetroBoardColumnKey;
  text: string;
  color?: string;
  /**
   * Client-generated temporary id for the optimistic placeholder so the
   * caller can render it at reduced opacity until the server id arrives and
   * can target it for rollback on failure.
   */
  tempId: string;
}

/**
 * POST /api/v1/sprints/{id}/retro-board/ — create a sticky.
 *
 * Optimistically inserts a placeholder sticky (rendered at 70% opacity by the
 * caller until confirmed) so concurrent writers see their own card instantly;
 * onError rolls the placeholder back and the caller surfaces an inline retry.
 */
export function useCreateBoardItem(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<RetroBoardItem, Error, CreateBoardItemInput, BoardSnapshot>({
    mutationFn: async ({ column, text, color }) => {
      const res = await apiClient.post<RetroBoardItem>(
        `/sprints/${sprintId}/retro-board/`,
        { column, text, ...(color !== undefined ? { color } : {}) },
      );
      return res.data;
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: boardKey(sprintId) });
      const snapshot = queryClient.getQueryData<RetroBoardResponse>(boardKey(sprintId));
      if (snapshot) {
        const placeholder: RetroBoardItem = {
          id: vars.tempId,
          retro: '',
          column: vars.column,
          text: vars.text,
          author: null,
          author_username: null,
          position: Number.MAX_SAFE_INTEGER,
          color: vars.color ?? '',
          converted_action_item_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        queryClient.setQueryData<RetroBoardResponse>(boardKey(sprintId), {
          ...snapshot,
          items: [...snapshot.items, placeholder],
        });
      }
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(boardKey(sprintId), context.snapshot);
      }
    },
    onSuccess: (created, vars) => {
      // Swap the optimistic placeholder for the server row in place so the
      // card never flickers out and back in.
      queryClient.setQueryData<RetroBoardResponse>(boardKey(sprintId), (old) =>
        old
          ? { ...old, items: old.items.map((it) => (it.id === vars.tempId ? created : it)) }
          : old,
      );
    },
  });
}

export interface UpdateBoardItemInput {
  id: string;
  /** Edit text and/or recolor. */
  text?: string;
  color?: string;
  /** Move: reassign column and/or position. */
  column?: RetroBoardColumnKey;
  position?: number;
}

/**
 * PATCH /api/v1/retro-items/{id}/ — edit text/color and/or move (column/position).
 *
 * LWW on `server_version` server-side (ADR-0117 §3): a stale PATCH is reconciled
 * by the next retro_item_updated delta. Optimistically patches the cache so the
 * editor and peers see the change immediately; onError rolls back.
 */
export function useUpdateBoardItem(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<RetroBoardItem, Error, UpdateBoardItemInput, BoardSnapshot>({
    mutationFn: async ({ id, ...patch }) => {
      const res = await apiClient.patch<RetroBoardItem>(`/retro-items/${id}/`, patch);
      return res.data;
    },
    onMutate: async ({ id, ...patch }) => {
      await queryClient.cancelQueries({ queryKey: boardKey(sprintId) });
      const snapshot = queryClient.getQueryData<RetroBoardResponse>(boardKey(sprintId));
      if (snapshot) {
        queryClient.setQueryData<RetroBoardResponse>(boardKey(sprintId), {
          ...snapshot,
          items: snapshot.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
        });
      }
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(boardKey(sprintId), context.snapshot);
      }
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<RetroBoardResponse>(boardKey(sprintId), (old) =>
        old
          ? { ...old, items: old.items.map((it) => (it.id === updated.id ? updated : it)) }
          : old,
      );
    },
  });
}

/**
 * DELETE /api/v1/retro-items/{id}/ — remove a sticky (author or Admin+).
 * Optimistically removes the card; onError restores it.
 */
export function useDeleteBoardItem(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string, BoardSnapshot>({
    mutationFn: async (id) => {
      await apiClient.delete(`/retro-items/${id}/`);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: boardKey(sprintId) });
      const snapshot = queryClient.getQueryData<RetroBoardResponse>(boardKey(sprintId));
      if (snapshot) {
        queryClient.setQueryData<RetroBoardResponse>(boardKey(sprintId), {
          ...snapshot,
          items: snapshot.items.filter((it) => it.id !== id),
        });
      }
      return { snapshot };
    },
    onError: (_err, _id, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(boardKey(sprintId), context.snapshot);
      }
    },
  });
}

/**
 * POST /api/v1/retro-items/{id}/convert-to-action/ — turn a discussion sticky
 * into a committed RetroActionItem (§1). Idempotent: a re-convert returns the
 * existing action item (200). Invalidates the retro read so the new action
 * item surfaces in the Action items section with its #858 Promote button.
 */
export function useConvertStickyToAction(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<SprintRetroActionItem, Error, string>({
    mutationFn: async (id) => {
      const res = await apiClient.post<SprintRetroActionItem>(
        `/retro-items/${id}/convert-to-action/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey(sprintId) });
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'retro'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Team-health pulse (#923, ADR-0117 §5)
// ---------------------------------------------------------------------------

/** The requester's own pulse response for this sprint (echoed back so they can re-tap). */
export interface PulseResponse {
  id: string;
  retro: string;
  mood: number;
  energy: number;
  confidence: number | null;
  updated_at: string;
}

export interface UpsertPulseInput {
  mood: number;
  energy: number;
  /** Optional third dimension; skipping sends null. */
  confidence?: number | null;
}

/**
 * GET /api/v1/sprints/{id}/pulse/ — the requester's own pulse response.
 * A 204 (not yet answered) is translated to a sentinel `null` so the caller
 * can render the poll in its unanswered state.
 */
export function usePulse(sprintId: string | null | undefined) {
  return useQuery<PulseResponse | null>({
    queryKey: ['sprint', sprintId, 'pulse'],
    queryFn: async () => {
      const res = await apiClient.get<PulseResponse | ''>(`/sprints/${sprintId}/pulse/`);
      // 204 No Content surfaces as an empty body; treat as "not answered yet".
      if (res.status === 204 || !res.data) return null;
      return res.data;
    },
    enabled: !!sprintId,
  });
}

/**
 * PUT /api/v1/sprints/{id}/pulse/ — upsert *my* response (one tap).
 *
 * Idempotent by the unique(retro, respondent) constraint — a re-tap updates,
 * never duplicates (ADR-0117 §5). Optimistically writes the new answer so the
 * selected halo appears instantly; refreshes the trend on success (the trend
 * has no WS event by design — privacy — so it must refetch here).
 */
export function useUpsertPulse(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    PulseResponse,
    Error,
    UpsertPulseInput,
    { snapshot: PulseResponse | null | undefined }
  >({
    mutationFn: async ({ mood, energy, confidence }) => {
      const res = await apiClient.put<PulseResponse>(`/sprints/${sprintId}/pulse/`, {
        mood,
        energy,
        confidence: confidence ?? null,
      });
      return res.data;
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['sprint', sprintId, 'pulse'] });
      const snapshot = queryClient.getQueryData<PulseResponse | null>([
        'sprint',
        sprintId,
        'pulse',
      ]);
      queryClient.setQueryData<PulseResponse | null>(
        ['sprint', sprintId, 'pulse'],
        (old) => ({
          id: old?.id ?? 'optimistic',
          retro: old?.retro ?? '',
          mood: vars.mood,
          energy: vars.energy,
          confidence: vars.confidence ?? null,
          updated_at: new Date().toISOString(),
        }),
      );
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context && context.snapshot !== undefined) {
        queryClient.setQueryData(['sprint', sprintId, 'pulse'], context.snapshot);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['sprint', sprintId, 'pulse'], data);
      // The trend aggregate has no WS event (privacy); refetch it so the
      // requester's own answer is reflected in the latest point immediately.
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'pulse-trend'] });
    },
  });
}

/** One aggregated trend point per sprint (server-computed, ordered oldest→newest). */
export interface PulseTrendPoint {
  sprint_id: string;
  sprint_name: string;
  avg_mood: number | null;
  avg_energy: number | null;
  avg_confidence: number | null;
  response_count: number;
}

/**
 * The pulse-trend read is a discriminated union on `gated` (ADR-0104 / ADR-0117
 * §5). When the requester is above the pulse signal's audience the server
 * returns `{gated: true}` with NO numbers — the client renders the "kept
 * private" wall, never a teaser, count, or blur.
 */
export type PulseTrendResponse =
  | { gated: true }
  | {
      gated: false;
      points: PulseTrendPoint[];
      energy_declining: boolean;
      my_response: { mood: number; energy: number; confidence: number | null } | null;
    };

/**
 * GET /api/v1/sprints/{id}/pulse-trend/ — the cross-sprint aggregate trend.
 *
 * Gated by `can_read_signal(..., "pulse")` server-side: above-audience readers
 * receive `{gated: true}` and the client shows PulseGatedWall. There is no
 * pulse WebSocket event by design (privacy) — this query refetches when the
 * retro opens and after the requester upserts their own response.
 */
export function usePulseTrend(sprintId: string | null | undefined) {
  return useQuery<PulseTrendResponse>({
    queryKey: ['sprint', sprintId, 'pulse-trend'],
    queryFn: async () => {
      const res = await apiClient.get<PulseTrendResponse>(
        `/sprints/${sprintId}/pulse-trend/`,
      );
      return res.data;
    },
    enabled: !!sprintId,
  });
}
