/**
 * Sync engine boundary (ADR-0026 §Data layer). EMPTY TYPED BOUNDARY — the
 * pull/push/outbox implementation is filled by #41.
 *
 * Important (ADR-0026 §6, blocker B-3): the server sync protocol ALREADY EXISTS.
 * #41 is a CLIENT-side adapter against the shipped endpoints, not new server
 * endpoints:
 *   - GET  /api/v1/projects/{pk}/sync/?since={cursor}
 *           → live rows + soft-deleted tombstones changed after the cursor,
 *             WatermelonDB-formatted, per-project, Viewer+ may pull.
 *   - POST /api/v1/projects/{pk}/sync/
 *           → push; write-role required; per-row idempotency + conflict resolve.
 *   - POST /api/v1/ws/ticket/  → WebSocket auth ticket (apps/sync/urls.py).
 */
import type { SyncedTable } from '../db/schema';

/** WatermelonDB-shaped changes for one table: created/updated rows + deleted ids. */
export interface TableChanges<Row> {
  created: Row[];
  updated: Row[];
  deleted: string[];
}

/** A pull payload keyed by collection — the shape ProjectSyncView returns. */
export type SyncChanges = Partial<Record<SyncedTable, TableChanges<Record<string, unknown>>>>;

/**
 * Collections the server accepts on UPLOAD. This is deliberately NOT
 * `SyncedTable`: v1 exposes only `tasks` (`WRITABLE_COLLECTIONS`,
 * `apps/sync/upload.py`), and every other key is rejected with an explicit 400
 * rather than silently dropped (ADR-0082 §B). Typing `push` on the pull union
 * would promise 14 calls that are guaranteed refusals.
 */
export type WritableTable = 'tasks';

/** Upload payload — a `tasks`-only subset of the pull shape. */
export type WritableChanges = Partial<Record<WritableTable, TableChanges<Record<string, unknown>>>>;

/** Result of a pull: the changes plus the new high-water cursor.
 *
 *  `timestamp` is OPAQUE — store it and echo it back as the next `since`, and
 *  never compare it against a row's `server_version` (ADR-0686). The two are
 *  different number lines: `timestamp` is the project's delta cursor, while
 *  `server_version` is that row's own save count and its optimistic-lock token.
 *  Treating them as one is the defect #2491 fixed server-side, and the adapter
 *  must not reintroduce it client-side. */
export interface PullResult {
  changes: SyncChanges;
  timestamp: number;
  /** Opaque page token (#1013). Non-null means the delta is NOT fully drained:
   *  call `pull` again with this value and the SAME `since`. Null on the last
   *  page. Do not use the response's `has_more` — it is deprecated and removed
   *  in 0.5, and a client that reads it as `undefined` treats a partial sync as
   *  a complete one. */
  nextCursor: string | null;
}

/**
 * Client sync engine the #41 adapter implements. Declared as a typed boundary
 * so feature code and tests can depend on the contract before the WatermelonDB
 * synchronize() wiring exists.
 */
export interface SyncEngine {
  /**
   * Pull one page of rows changed after the local high-water cursor.
   *
   * `since` is an opaque `timestamp` from a previous PullResult (0 for a full
   * sync). The delta is PAGINATED (#1013), so a single call is not a sync — the
   * drain loop is:
   *
   *   let cursor: string | null = null;
   *   do { const p = await pull(id, since, cursor ?? undefined);
   *        apply(p.changes); cursor = p.nextCursor; } while (cursor);
   *   // only now adopt p.timestamp as the next `since`
   *
   * `since` stays CONSTANT for the whole session; `timestamp` is pinned by the
   * server on the first page and adopted only after the last one.
   */
  pull(projectId: string, since: number, cursor?: string): Promise<PullResult>;
  /** Push locally-queued changes (offline outbox). `tasks` only — see
   *  WritableTable. */
  push(projectId: string, changes: WritableChanges): Promise<void>;
}
