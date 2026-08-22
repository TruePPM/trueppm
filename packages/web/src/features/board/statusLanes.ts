/**
 * Named board lanes — the second axis over the five canonical statuses (#2967).
 *
 * A column can be subdivided into N **named lanes** (Review / QA / Blocked …)
 * while `Task.status` stays one of the five canonical values, so burndown,
 * throughput rollup, MS Project export, saved views and every integration keep
 * reading status unchanged. A lane is stored on the card as `boardLane`, a bare
 * key the server keeps unique project-wide.
 *
 * This module turns a board config into the **track list** the grid renders: one
 * track per lane, or one track per column when that column configures no lanes.
 * Every grid surface (header row, milestone rail, each phase lane) keys on
 * `track.key`, which is:
 *
 *   - exactly the status string when the column has no lanes, and
 *   - `` `${status}#${laneKey}` `` when it does.
 *
 * That identity is deliberate and load-bearing. On an unladen board — every
 * project that never opens the lane editor, which is all of them today — the
 * track list is byte-identical to the old column list, so persisted column
 * widths, the collapsed-column set, droppable ids, keyboard navigation and every
 * E2E selector keep working with no migration and no fallback branch.
 *
 * Relationship to `laneAssignment.ts` (ADR-0843, the case 16 rule): that module
 * owns the board's *horizontal* grouping — which swimlane row a card sits in,
 * and the rule that a container is never a card. This one owns the *vertical*
 * subdivision of a status column. They compose; neither replaces the other, and
 * a container still never becomes a card in either.
 */
import type { Task, TaskStatus } from '@/types';
import type { BoardColumnDef, BoardLaneDef } from '@/hooks/useBoardConfig';

/** Separator between a status and its lane key in a track key. */
const LANE_SEP = '#';

/**
 * Ceiling on named lanes per column. Mirrors `MAX_LANES_PER_COLUMN` in
 * `apps/projects/serializers.py` — the server is the authority and rejects a
 * longer list; this copy is what stops the editor building a payload it knows
 * will 400.
 */
export const MAX_LANES_PER_COLUMN = 6;

/** One rendered board column track: a whole status, or one named lane of it. */
export interface BoardTrack {
  /** Grid identity — `status` when unladen, `status#laneKey` when a lane. */
  key: string;
  status: TaskStatus;
  /** Lane key, or null when this track is the whole status column. */
  laneKey: string | null;
  /** What the header renders: the lane name when a lane, else the column label. */
  label: string;
  /** The owning column's label — the accessible name prefixes it on a lane track. */
  columnLabel: string;
  /** Lane WIP limit when a lane, else the column's. */
  wipLimit: number | null;
  /** The owning column's WIP limit, kept alongside the lane's so the folded
   *  stub — which stands for the whole column — can still show its band. */
  columnWipLimit: number | null;
  color: string | null;
  slaDays?: number;
}

/** Build the grid identity for a (status, lane) pair. */
export function trackKey(status: TaskStatus, laneKey: string | null): string {
  return laneKey ? `${status}${LANE_SEP}${laneKey}` : status;
}

/** Split a track key back into its status and lane. Inverse of {@link trackKey}. */
export function parseTrackKey(key: string): { status: TaskStatus; laneKey: string | null } {
  const at = key.indexOf(LANE_SEP);
  if (at === -1) return { status: key as TaskStatus, laneKey: null };
  return { status: key.slice(0, at) as TaskStatus, laneKey: key.slice(at + 1) };
}

/**
 * Expand configured columns into the tracks the grid draws.
 *
 * A column with no lanes yields exactly one track whose key *is* its status —
 * see the module note on why that identity matters.
 */
export function expandColumnTracks(columns: readonly BoardColumnDef[]): BoardTrack[] {
  const tracks: BoardTrack[] = [];
  for (const col of columns) {
    const lanes = col.lanes ?? [];
    if (lanes.length === 0) {
      tracks.push({
        key: col.status,
        status: col.status,
        laneKey: null,
        label: col.label,
        columnLabel: col.label,
        wipLimit: col.wipLimit,
        columnWipLimit: col.wipLimit,
        color: col.color,
        slaDays: col.slaDays,
      });
      continue;
    }
    for (const lane of lanes) {
      tracks.push({
        key: trackKey(col.status, lane.key),
        status: col.status,
        laneKey: lane.key,
        label: lane.label,
        columnLabel: col.label,
        // A lane's own limit governs its track; a lane with no limit inherits
        // nothing, because the column limit is measured across every lane and
        // showing it on each one would read as N copies of the same ceiling.
        wipLimit: lane.wipLimit,
        columnWipLimit: col.wipLimit,
        color: col.color,
        slaDays: col.slaDays,
      });
    }
  }
  return tracks;
}

/**
 * Fold every lane of a collapsed column back into one stub track.
 *
 * Collapse (#1459) is a status-level control — "Collapse Review" hides Review,
 * not Review's third lane. Folding here rather than in each renderer keeps the
 * header row, the milestone rail and every phase lane building their grid from
 * the identical track list, which is what holds their columns pixel-aligned.
 */
export function collapseTracks(
  tracks: readonly BoardTrack[],
  collapsedColumns: ReadonlySet<TaskStatus>,
): BoardTrack[] {
  if (collapsedColumns.size === 0) return [...tracks];
  const out: BoardTrack[] = [];
  const stubbed = new Set<TaskStatus>();
  for (const track of tracks) {
    if (!collapsedColumns.has(track.status)) {
      out.push(track);
      continue;
    }
    if (stubbed.has(track.status)) continue;
    stubbed.add(track.status);
    out.push({
      ...track,
      key: track.status,
      laneKey: null,
      label: track.columnLabel,
      // The stub stands for the whole COLUMN, so it carries the column's
      // ceiling — a lane's own limit would band the stub against a fraction of
      // what it now represents (#1695's always-on breach signal).
      wipLimit: track.columnWipLimit,
    });
  }
  return out;
}

/**
 * Index of status → the lane keys configured for it, in board order.
 *
 * Built once per config change so {@link resolveTrackKey} is O(1) per card.
 */
export function buildLaneKeyIndex(columns: readonly BoardColumnDef[]): Map<TaskStatus, string[]> {
  const index = new Map<TaskStatus, string[]>();
  for (const col of columns) {
    const lanes = col.lanes ?? [];
    if (lanes.length > 0) index.set(col.status, lanes.map((l) => l.key));
  }
  return index;
}

/**
 * The track a card renders in.
 *
 * A card whose `boardLane` is empty — or names a lane that has since been
 * deleted from the config — resolves to the column's **first** lane. That
 * fallback is the whole reason deleting a lane needs no data migration: the
 * server counts orphans into the first lane by the same rule
 * (`_annotate_lane_breach`), so the header badge and the cards beneath it can
 * never disagree.
 */
export function resolveTrackKey(task: Task, laneIndex: Map<TaskStatus, string[]>): string {
  const lanes = laneIndex.get(task.status);
  if (!lanes || lanes.length === 0) return task.status;
  const lane = task.boardLane;
  return trackKey(task.status, lane && lanes.includes(lane) ? lane : lanes[0]);
}

/**
 * True when at least one column configures a named lane. False means the track
 * list *is* the column list, so callers skip lane-only work entirely.
 */
export function hasNamedLanes(columns: readonly BoardColumnDef[]): boolean {
  return columns.some((c) => (c.lanes ?? []).length > 0);
}

/** A lane key proposed in the settings editor, normalized to the server's slug rule. */
export function slugifyLaneKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Every lane key already spoken for across the whole config.
 *
 * The server enforces project-wide uniqueness (a key names exactly one
 * (status, lane) pair, so a status move can never alias a card into a
 * same-named lane of another column). The editor has to honor the same scope or
 * it produces payloads the API rejects.
 */
export function usedLaneKeys(columns: readonly BoardColumnDef[]): Set<string> {
  const used = new Set<string>();
  for (const col of columns) for (const lane of col.lanes ?? []) used.add(lane.key);
  return used;
}

/** Derive a unique lane key for `label` within `columns`. */
export function uniqueLaneKey(label: string, columns: readonly BoardColumnDef[]): string {
  const used = usedLaneKeys(columns);
  const base = slugifyLaneKey(label) || 'lane';
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 29)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}-${Date.now() % 100000}`;
}

export type { BoardLaneDef };
