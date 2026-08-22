/**
 * Fetches and mutates the per-project board column configuration.
 * Falls back to the hardcoded 5-column default when no config is saved.
 *
 * API shape uses snake_case (wip_limit); this hook translates to camelCase
 * for consumers and back to snake_case on save.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';

/**
 * One named lane inside a status column (#2967).
 *
 * `key` is the value stored on `Task.boardLane`; the server keeps it unique
 * project-wide so it names exactly one (status, lane) pair.
 */
export interface BoardLaneDef {
  key: string;
  label: string;
  /** Per-lane WIP limit. Null = no limit; independent of the column's. */
  wipLimit: number | null;
  /** Live card count in this lane — server-derived, read only. */
  currentCount?: number;
  /** Server WIP verdict for this lane: 'ok' | 'at' | 'over', or null/absent. */
  breach?: 'ok' | 'at' | 'over' | null;
}

export interface BoardColumnDef {
  status: TaskStatus;
  label: string;
  visible: boolean;
  /**
   * WIP limit for this column. Null = no limit (displayed as ∞).
   * Advisory only — UI shows amber chip when over limit; never blocks drops.
   */
  wipLimit: number | null;
  /**
   * Column accent color as #RRGGBB hex, or null to use the default tint.
   * Persisted server-side per ADR-0039.
   */
  color: string | null;
  /**
   * Per-column aging threshold OVERRIDE in calendar days, persisted server-side
   * (ADR-0164, issue 410). `null` = use the client default for this status
   * (COLUMN_SLA_DEFAULTS). The settings page edits this raw override.
   */
  ageThresholdDays: number | null;
  /**
   * Effective cycle-time SLA in calendar days the board card consumes: the saved
   * `ageThresholdDays` override when set, else the per-status default. Cards in this
   * column longer than slaDays show an aging indicator (issue #192). Derived — read
   * only, never edited directly.
   */
  slaDays?: number;
  /**
   * Named lanes subdividing this column (#2967), in board order. Empty (the
   * default, and every project that has never opened the lane editor) means one
   * implicit lane — the board exactly as it rendered before lanes existed.
   *
   * Lanes hang off the column rather than sitting beside one because the API
   * rejects a repeated status key, and that rejection is what keeps
   * `Task.status` canonical for burndown, rollup, export and integrations.
   *
   * Optional so a payload from a server that predates #2967 — and every fixture
   * written before it — reads as an unladen column rather than a type error.
   */
  lanes?: BoardLaneDef[];
}

// API wire format — snake_case. slaDays is derived (not persisted); ageThresholdDays
// round-trips as age_threshold_days.
interface ApiLane {
  key: string;
  label: string;
  wip_limit: number | null;
  current_count?: number;
  breach?: 'ok' | 'at' | 'over' | null;
}

interface ApiColumn {
  status: TaskStatus;
  label: string;
  visible: boolean;
  wip_limit: number | null;
  color: string | null;
  age_threshold_days?: number | null;
  lanes?: ApiLane[];
}

interface BoardConfigResponse {
  columns: ApiColumn[];
}

// Per-status default aging thresholds — the fallback when a column has no saved
// `ageThresholdDays` override (issue 192 behavior). Exported so the settings page can show
// each column's default as the input placeholder (issue 410).
export const COLUMN_SLA_DEFAULTS: Partial<Record<TaskStatus, number>> = {
  BACKLOG: 14,
  NOT_STARTED: 7,
  IN_PROGRESS: 10,
  REVIEW: 4,
};

// 5-column model per Claude Design handoff (issue #178).
// ON_HOLD is hidden but kept in the type union for migration compatibility — tasks
// that are ON_HOLD in the API will not appear on the board until they are migrated.
const DEFAULT_COLUMNS: BoardColumnDef[] = [
  { status: 'BACKLOG', label: 'Backlog', visible: true, wipLimit: null, color: '#94A3B8', ageThresholdDays: null, slaDays: 14, lanes: [] },
  { status: 'NOT_STARTED', label: 'To Do', visible: true, wipLimit: null, color: '#64748B', ageThresholdDays: null, slaDays: 7, lanes: [] },
  { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wipLimit: 5, color: '#3B82F6', ageThresholdDays: null, slaDays: 10, lanes: [] },
  { status: 'REVIEW', label: 'Review', visible: true, wipLimit: 3, color: '#A855F7', ageThresholdDays: null, slaDays: 4, lanes: [] },
  { status: 'COMPLETE', label: 'Done', visible: true, wipLimit: null, color: '#22C55E', ageThresholdDays: null, lanes: [] },
];

function fromApi(col: ApiColumn): BoardColumnDef {
  // Effective SLA: the saved override when present, else the per-status client
  // default. `age_threshold_days` may be absent (legacy config) or null (unset).
  const override = col.age_threshold_days ?? null;
  const effectiveSla = override ?? COLUMN_SLA_DEFAULTS[col.status];
  return {
    status: col.status,
    label: col.label,
    visible: col.visible,
    wipLimit: col.wip_limit,
    color: col.color,
    ageThresholdDays: override,
    slaDays: effectiveSla,
    // Absent on a payload from a server that predates #2967 — an unladen column,
    // which is also what an empty list means, so one branch covers both.
    lanes: (col.lanes ?? []).map((l) => ({
      key: l.key,
      label: l.label,
      wipLimit: l.wip_limit,
      currentCount: l.current_count,
      breach: l.breach,
    })),
  };
}

function toApi(col: BoardColumnDef): ApiColumn {
  return {
    status: col.status,
    label: col.label,
    visible: col.visible,
    wip_limit: col.wipLimit,
    color: col.color,
    age_threshold_days: col.ageThresholdDays ?? null,
    // current_count / breach are server-derived and deliberately not echoed back:
    // the PUT is the desired configuration, not a snapshot of the board's state.
    lanes: (col.lanes ?? []).map((l) => ({
      key: l.key,
      label: l.label,
      wip_limit: l.wipLimit,
    })),
  };
}

async function fetchBoardConfig(projectId: string): Promise<BoardColumnDef[]> {
  const resp = await apiClient.get<BoardConfigResponse>(`/projects/${projectId}/board-config/`);
  return resp.data.columns.map(fromApi);
}

async function saveBoardConfig(projectId: string, columns: BoardColumnDef[]): Promise<BoardColumnDef[]> {
  const resp = await apiClient.put<BoardConfigResponse>(`/projects/${projectId}/board-config/`, {
    columns: columns.map(toApi),
  });
  return resp.data.columns.map(fromApi);
}

export function useBoardConfig(projectId: string | null | undefined): {
  columns: BoardColumnDef[];
  isLoading: boolean;
  save: (columns: BoardColumnDef[]) => Promise<void>;
} {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['boardConfig', projectId],
    queryFn: () => fetchBoardConfig(projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (columns: BoardColumnDef[]) => saveBoardConfig(projectId!, columns),
    onSuccess: (result) => {
      queryClient.setQueryData(['boardConfig', projectId], result);
    },
  });

  return {
    columns: data ?? DEFAULT_COLUMNS,
    isLoading,
    save: async (columns) => {
      await mutation.mutateAsync(columns);
    },
  };
}
