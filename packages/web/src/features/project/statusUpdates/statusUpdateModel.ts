import type { SnapshotRow } from '@/components/page2/SnapshotPanel';
import type {
  StatusUpdate,
  StatusUpdateLiveDiffEntry,
  StatusUpdateMetric,
  StatusUpdateSnapshot,
} from '@/api/types';
import { fmtUtcMedium } from '@/lib/formatUtcDate';
import type { Rag } from '@/lib/ragBand';

/** The narrative cap the API enforces (`StatusUpdate.narrative`, max_length=600). */
export const NARRATIVE_MAX = 600;

/** The first line is what history and the program row show. */
export function firstLine(narrative: string): string {
  return narrative.split('\n', 1)[0]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Draft: one per project per author, on this device only.
// ---------------------------------------------------------------------------

export interface StatusDraft {
  rag: Rag | null;
  narrative: string;
  savedAt: string;
}

const DRAFT_PREFIX = 'trueppm:status-update-draft:v1';

/** One key per project per author: two PMs on one device never share a draft. */
export function draftKey(projectId: string, userId: string | number): string {
  return `${DRAFT_PREFIX}:${projectId}:${userId}`;
}

function isRag(v: unknown): v is Rag {
  return v === 'green' || v === 'amber' || v === 'red';
}

/**
 * The saved draft, or null. Storage can be absent or throw (private window,
 * blocked site data), and a stored value can be from anywhere, so every read is
 * guarded and shape-checked; a bad value reads as "no draft", never a crash.
 */
export function loadDraft(projectId: string, userId: string | number): StatusDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(projectId, userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    const rag = p.rag === null || isRag(p.rag) ? p.rag : null;
    const narrative = typeof p.narrative === 'string' ? p.narrative.slice(0, NARRATIVE_MAX) : '';
    const savedAt = typeof p.savedAt === 'string' ? p.savedAt : '';
    if (rag === null && narrative === '') return null;
    return { rag, narrative, savedAt };
  } catch {
    return null;
  }
}

/** Saves (or, when empty, clears) the draft. Returns false when storage refused it. */
export function saveDraft(
  projectId: string,
  userId: string | number,
  draft: Omit<StatusDraft, 'savedAt'>,
  now: Date = new Date(),
): boolean {
  try {
    if (draft.rag === null && draft.narrative === '') {
      window.localStorage.removeItem(draftKey(projectId, userId));
      return true;
    }
    const value: StatusDraft = { ...draft, savedAt: now.toISOString() };
    window.localStorage.setItem(draftKey(projectId, userId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(projectId: string, userId: string | number): void {
  try {
    window.localStorage.removeItem(draftKey(projectId, userId));
  } catch {
    // Storage unavailable: there is nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Snapshot rows: frozen values beside the API's live diff.
// ---------------------------------------------------------------------------

const REASON_TEXT: Record<string, string> = {
  no_forecast: 'no forecast has run',
  no_percentile: 'the forecast has no percentile',
  no_cpm_finish: 'the schedule has no finish yet',
  no_baseline: 'no baseline is set',
  no_previous_update: 'this is the first update',
};

function fmtDate(v: string | number | null | undefined): string | null {
  return typeof v === 'string' ? fmtUtcMedium(v) : null;
}

function fmtDays(v: string | number | null | undefined): string | null {
  if (typeof v !== 'number') return null;
  return v > 0 ? `+${v}d` : `${v}d`;
}

function fmtCount(v: string | number | null | undefined): string | null {
  return typeof v === 'number' ? String(v) : null;
}

type Fmt = (v: string | number | null | undefined) => string | null;

function row(
  key: string,
  label: string,
  metric: StatusUpdateMetric<string | number | null> | undefined,
  fmt: Fmt,
  diff: Record<string, StatusUpdateLiveDiffEntry> | undefined,
): SnapshotRow {
  const moved = diff?.[key];
  return {
    id: key,
    label,
    value: fmt(metric?.value),
    definition: metric?.definition,
    notComputable: metric?.reason ? (REASON_TEXT[metric.reason] ?? undefined) : undefined,
    // A moved figure whose current value is null reads "now not computable".
    now: moved ? (fmt(moved.value) ?? 'not computable') : undefined,
  };
}

/**
 * The figures the panel reads: a posted update's snapshot, or the share projection
 * of one (#4805), which carries the same metric shapes minus the internal fields.
 */
export interface SnapshotFacts {
  forecast?: Partial<
    Pick<
      StatusUpdateSnapshot['forecast'],
      'p50' | 'p80' | 'cpm_finish' | 'baseline_finish_variance_days'
    >
  >;
  counts?: Partial<StatusUpdateSnapshot['counts']>;
}

/**
 * The panel rows for a snapshot. With `diff` (a posted update's `live_diff`) each
 * moved figure gets its current value as `now`; the frozen value is never replaced.
 * Keys are the API's dotted live-diff keys, so the match is by name, not by guess.
 */
export function snapshotRows(
  snapshot: SnapshotFacts,
  diff?: Record<string, StatusUpdateLiveDiffEntry>,
): SnapshotRow[] {
  const f = snapshot.forecast;
  const c = snapshot.counts;
  return [
    row('forecast.p80', 'Forecast finish · P80', f?.p80, fmtDate, diff),
    row('forecast.p50', 'P50', f?.p50, fmtDate, diff),
    row('forecast.cpm_finish', 'CPM finish', f?.cpm_finish, fmtDate, diff),
    row(
      'forecast.baseline_finish_variance_days',
      'Versus baseline',
      f?.baseline_finish_variance_days,
      fmtDays,
      diff,
    ),
    row(
      'counts.completed_since_previous',
      'Completed since last',
      c?.completed_since_previous,
      fmtCount,
      undefined,
    ),
    row(
      'counts.slipped_since_previous',
      'Milestones slipped since last',
      c?.slipped_since_previous,
      fmtCount,
      undefined,
    ),
  ];
}

/** The current value of a moved milestone field, from the live diff; else undefined. */
export function milestoneNow(
  diff: Record<string, StatusUpdateLiveDiffEntry> | undefined,
  taskId: string,
): string | undefined {
  if (!diff) return undefined;
  if (diff[`milestones.${taskId}`]?.reason === 'removed') return 'removed from the plan';
  const finish = diff[`milestones.${taskId}.cpm_finish`];
  if (finish) return fmtDate(finish.value) ?? 'not computable';
  const variance = diff[`milestones.${taskId}.variance_days`];
  if (variance) return fmtDays(variance.value) ?? 'not computable';
  return undefined;
}

/** The computed band the plan reads NOW for the newest update: the diff's, else the frozen one. */
export function currentComputedHealth(latest: StatusUpdate | undefined): string | null {
  if (!latest) return null;
  const moved = latest.live_diff?.computed_health?.value;
  return typeof moved === 'string' ? moved : latest.computed_health;
}
