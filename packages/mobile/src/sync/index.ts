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
 *   - POST /api/v1/sync/ws/ticket/  → WebSocket auth ticket.
 */
import type { SyncedTable } from '../db/schema';

/** WatermelonDB-shaped changes for one table: created/updated rows + deleted ids. */
export interface TableChanges<Row> {
  created: Row[];
  updated: Row[];
  deleted: string[];
}

/** A full pull/push payload keyed by table — the shape the existing
 *  ProjectSyncView already returns and accepts. */
export type SyncChanges = Partial<Record<SyncedTable, TableChanges<Record<string, unknown>>>>;

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
}

/**
 * Client sync engine the #41 adapter implements. Declared as a typed boundary
 * so feature code and tests can depend on the contract before the WatermelonDB
 * synchronize() wiring exists.
 */
export interface SyncEngine {
  /** Pull rows changed after the local high-water cursor (an opaque
   *  `timestamp` from a previous PullResult; 0 for a full sync). */
  pull(projectId: string, since: number): Promise<PullResult>;
  /** Push locally-queued changes (offline outbox) for a project. */
  push(projectId: string, changes: SyncChanges): Promise<void>;
}
