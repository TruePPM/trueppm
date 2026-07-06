/**
 * Offline blocker-flag write queue — durable data layer (ADR-0247).
 *
 * The field PM's most schedule-critical no-signal action is flagging a task
 * blocked (ADR-0124): "concrete can't be poured — inspector no-show", typed
 * standing in the mud. ADR-0220 solved the identical shape for board card-status
 * moves; this is its blocker-write sibling — an IndexedDB-backed queue that
 * survives reload and flushes on reconnect, replaying the same `PATCH /tasks/{id}/`
 * the online path uses.
 *
 * The queue lives in its OWN database (`trueppm-blocker-offline`), not a second
 * store on the board's DB: sharing a DB name across two independently-loaded
 * modules would force both to open the same monotonic version and both `upgrade`
 * callbacks to know every store. A distinct DB keeps the two queues decoupled.
 *
 * The `idb` package is only touched lazily inside these functions (never at
 * module load), so importing the pure helpers below in a non-browser test env is
 * safe — they degrade to in-memory-only (durability lost, reactive mirror intact).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Task } from '@/types';

/** A queued blocker write is either flagging/editing a blocker or clearing it. */
export type BlockerOpKind = 'flag' | 'unblock';

/** The variables a blocker write carries — the inputs `BlockerSection` collects. */
export interface BlockerVars {
  projectId: string;
  taskId: string;
  kind: BlockerOpKind;
  /**
   * For `kind: 'flag'`, the reason to persist, or `null` to leave the stored
   * reason unchanged (an edit by someone without read access to the private
   * reason — they can still change type/link). Ignored for `kind: 'unblock'`.
   */
  reason: string | null;
  /** Blocker type code; `''` clears the type ("No type"). Ignored for unblock. */
  blockerType: string;
  /** Soft "waiting on" task id, or `null`. Ignored for unblock. */
  blockingTask: string | null;
}

/** A queued, not-yet-flushed blocker write persisted in IndexedDB. */
export interface QueuedBlockerOp extends BlockerVars {
  /**
   * `Task.serverVersion` observed when this write was queued. On flush it is
   * replayed as the `X-Base-Version` header so the server field-merges a disjoint
   * concurrent edit (ADR-0217) and only 409s on an overlapping blocker-field edit —
   * so a queued flag survives an unrelated edit instead of being dropped.
   */
  baseServerVersion: number | null;
  /**
   * Whether the task was already flagged when this write was queued. A fresh flag
   * has no server-stamped age yet, so the UI shows "queued" rather than a fake
   * duration; an edit to an already-flagged task keeps the real age.
   */
  wasFlagged: boolean;
  /** Epoch ms the write was queued — flush order and LWW tie-break. */
  queuedAt: number;
}

interface BlockerOfflineSchema extends DBSchema {
  blockerQueue: { key: string; value: QueuedBlockerOp };
}

const DB_NAME = 'trueppm-blocker-offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'blockerQueue';

let dbPromise: Promise<IDBPDatabase<BlockerOfflineSchema>> | null = null;

/**
 * Open (once) the blocker-offline IndexedDB database.
 *
 * Returns `null` when IndexedDB is unavailable (SSR, jsdom without a polyfill) so
 * every call site degrades to an in-memory-only no-op rather than throwing — the
 * reactive Zustand mirror still works; only cross-reload durability is lost.
 */
function getDb(): Promise<IDBPDatabase<BlockerOfflineSchema>> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB<BlockerOfflineSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: 'taskId' });
        }
      },
    });
  }
  return dbPromise;
}

/** Persist (upsert by taskId → last-write-wins per task) a queued blocker write. */
export async function putQueuedBlockerOp(op: QueuedBlockerOp): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.put(QUEUE_STORE, op);
}

/** Read every queued blocker write across all projects. */
export async function getAllQueuedBlockerOps(): Promise<QueuedBlockerOp[]> {
  const db = await getDb();
  if (!db) return [];
  return db.getAll(QUEUE_STORE);
}

/** Remove a queued write once it has flushed (or been dropped on conflict). */
export async function deleteQueuedBlockerOp(taskId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(QUEUE_STORE, taskId);
}

// ---------------------------------------------------------------------------
// Pure helpers (no IndexedDB) — unit-tested in isolation.
// ---------------------------------------------------------------------------

/**
 * The optimistic partial applied to the cached `Task` while a write is queued.
 *
 * A flag reflects the typed values immediately; a fresh flag also stamps
 * `blockedAgeSeconds = 0` so `isFlagged` (`blockedAgeSeconds != null`) flips true
 * before the server responds — the UI renders that 0 as "queued", never a fake
 * duration. An unblock clears the flag optimistically; the server nulls the real
 * stamps on flush.
 */
export function optimisticBlockerPatch(vars: BlockerVars, wasFlagged: boolean): Partial<Task> {
  if (vars.kind === 'unblock') {
    return {
      blockedReason: '',
      blockerType: undefined,
      blockingTask: null,
      blockedAgeSeconds: null,
      blockedBy: null,
    };
  }
  const patch: Partial<Task> = {
    blockerType: vars.blockerType || undefined,
    blockingTask: vars.blockingTask,
  };
  if (vars.reason !== null) patch.blockedReason = vars.reason;
  if (!wasFlagged) patch.blockedAgeSeconds = 0;
  return patch;
}

/**
 * The PATCH body replayed to `/tasks/{id}/` on flush — identical to the online
 * blocker path. `reason: null` (a type/link edit without read access) omits
 * `blocked_reason` so the server keeps the stored reason.
 */
export function buildBlockerPatchBody(op: QueuedBlockerOp): Record<string, unknown> {
  if (op.kind === 'unblock') return { blocked_reason: '' };
  const body: Record<string, unknown> = {
    blocker_type: op.blockerType,
    blocking_task: op.blockingTask,
  };
  if (op.reason !== null) body['blocked_reason'] = op.reason;
  return body;
}

/**
 * Collapse an op list to one-per-task, keeping the latest by `queuedAt`.
 *
 * IndexedDB's `keyPath: 'taskId'` already enforces one row per task (so a queued
 * unblock replaces a queued flag for the same task and vice-versa — LWW), but
 * this makes the rule explicitly unit-testable for any in-memory list. Ties
 * (equal `queuedAt`) keep the later element in the array.
 */
export function collapseLatestPerTask(ops: QueuedBlockerOp[]): QueuedBlockerOp[] {
  const byTask = new Map<string, QueuedBlockerOp>();
  for (const op of ops) {
    const existing = byTask.get(op.taskId);
    if (!existing || op.queuedAt >= existing.queuedAt) byTask.set(op.taskId, op);
  }
  return [...byTask.values()];
}
