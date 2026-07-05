/**
 * Board offline card-status write queue — durable data layer (ADR-0220).
 *
 * The most common no-signal job-site action is moving a card between statuses.
 * ADR-0205 made the *in-memory* TanStack mutation cache the web write queue, but
 * that is lost on reload — exactly the failure mode for a PM who closes the tab
 * in a dead zone. This module is the persistent counterpart, scoped narrowly to
 * card-status moves on the board: an IndexedDB-backed queue that survives reload
 * and flushes on reconnect.
 *
 * Two IndexedDB stores:
 * - `cardStatusQueue` keyed by `taskId` — the upsert-by-task-id IS last-write-wins
 *   per task (a second offline move of the same card overwrites the first), so
 *   only the latest queued status ever flushes.
 * - `boardSnapshot` keyed by `projectId` — the last successful board fetch, used to
 *   render the board offline from the last-known state (criterion 1).
 *
 * The `idb` package is only touched lazily inside these functions (never at module
 * load), so importing the pure helpers below in a non-browser test env is safe.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Task, TaskStatus, TaskLink } from '@/types';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';

/** The variables a card-status move carries — mirrors `useUpdateTaskStatus`'s input. */
export interface CardStatusVars {
  projectId: string;
  taskId: string;
  status: TaskStatus;
  parentId?: string | null;
  sprintId?: string | null;
}

/** A queued, not-yet-flushed card-status move persisted in IndexedDB. */
export interface QueuedCardStatusOp extends CardStatusVars {
  /**
   * `Task.serverVersion` observed when this move was queued. On flush we compare
   * it against the server's *current* version; if the server advanced, a
   * concurrent edit happened while we were offline and we must not clobber it.
   */
  baseServerVersion: number | null;
  /** Epoch ms the move was queued — flush order and LWW tie-break. */
  queuedAt: number;
}

/** The board's last successful fetch, cached for offline read (criterion 1). */
export interface BoardSnapshot {
  projectId: string;
  tasks: Task[];
  dependencies: TaskLink[];
  boardConfig: BoardColumnDef[] | null;
  savedAt: number;
}

interface BoardOfflineSchema extends DBSchema {
  cardStatusQueue: { key: string; value: QueuedCardStatusOp };
  boardSnapshot: { key: string; value: BoardSnapshot };
}

const DB_NAME = 'trueppm-board-offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'cardStatusQueue';
const SNAPSHOT_STORE = 'boardSnapshot';

let dbPromise: Promise<IDBPDatabase<BoardOfflineSchema>> | null = null;

/**
 * Open (once) the board-offline IndexedDB database.
 *
 * Returns `null` when IndexedDB is unavailable (SSR, jsdom without a polyfill) so
 * every call site degrades to an in-memory-only no-op rather than throwing — the
 * reactive Zustand mirror still works; only cross-reload durability is lost.
 */
function getDb(): Promise<IDBPDatabase<BoardOfflineSchema>> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB<BoardOfflineSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: 'taskId' });
        }
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'projectId' });
        }
      },
    });
  }
  return dbPromise;
}

/** Persist (upsert by taskId → last-write-wins per task) a queued move. */
export async function putQueuedOp(op: QueuedCardStatusOp): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.put(QUEUE_STORE, op);
}

/** Read every queued move across all projects. */
export async function getAllQueuedOps(): Promise<QueuedCardStatusOp[]> {
  const db = await getDb();
  if (!db) return [];
  return db.getAll(QUEUE_STORE);
}

/** Remove a queued move once it has flushed (or been dropped on conflict). */
export async function deleteQueuedOp(taskId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(QUEUE_STORE, taskId);
}

/** Save the board's last successful fetch for offline read. */
export async function putBoardSnapshot(snapshot: BoardSnapshot): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.put(SNAPSHOT_STORE, snapshot);
}

/** Read a project's cached board snapshot, if any. */
export async function getBoardSnapshot(projectId: string): Promise<BoardSnapshot | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return db.get(SNAPSHOT_STORE, projectId);
}

// ---------------------------------------------------------------------------
// Pure helpers (no IndexedDB) — unit-tested in isolation.
// ---------------------------------------------------------------------------

/**
 * Has the server's version moved ahead of the version an offline edit was based on?
 *
 * `true` ⇔ a concurrent edit landed on the server while we were offline, so
 * replaying our stale status would silently clobber it. We yield to the server
 * instead (revert + toast). Missing versions are treated as "no conflict": we
 * cannot prove a concurrent edit, and blocking the user's queued move on absent
 * data would be more surprising than letting it through.
 */
export function hasServerAdvanced(
  baseServerVersion: number | null,
  currentServerVersion: number | null,
): boolean {
  if (baseServerVersion == null || currentServerVersion == null) return false;
  return currentServerVersion > baseServerVersion;
}

/**
 * Collapse an op list to one-per-task, keeping the latest by `queuedAt`.
 *
 * IndexedDB's `keyPath: 'taskId'` already enforces one row per task, so this is
 * belt-and-suspenders for any in-memory list and makes the LWW rule explicitly
 * unit-testable. Ties (equal `queuedAt`) keep the later element in the array.
 */
export function collapseLatestPerTask(ops: QueuedCardStatusOp[]): QueuedCardStatusOp[] {
  const byTask = new Map<string, QueuedCardStatusOp>();
  for (const op of ops) {
    const existing = byTask.get(op.taskId);
    if (!existing || op.queuedAt >= existing.queuedAt) byTask.set(op.taskId, op);
  }
  return [...byTask.values()];
}

/** The optimistic partial applied to the cached `Task` while a move is queued. */
export function optimisticStatusPatch(vars: CardStatusVars): Partial<Task> {
  const patch: Partial<Task> = { status: vars.status };
  // 'root' is the board's sentinel for "no parent"; map it to null like the API body.
  if (vars.parentId !== undefined) patch.parentId = vars.parentId === 'root' ? null : vars.parentId;
  if (vars.sprintId !== undefined) patch.sprintId = vars.sprintId;
  return patch;
}

/** The PATCH body replayed to `/tasks/{id}/` on flush — identical to the online path. */
export function buildStatusPatchBody(op: QueuedCardStatusOp): Record<string, unknown> {
  const body: Record<string, unknown> = { status: op.status };
  if (op.parentId !== undefined) body['parent_id'] = op.parentId === 'root' ? null : op.parentId;
  if (op.sprintId !== undefined) body['sprint_id'] = op.sprintId;
  return body;
}
