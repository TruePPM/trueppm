/**
 * Sync engine boundary (ADR-0026 §Data layer). EMPTY TYPED BOUNDARY — the
 * pull/push/outbox implementation is filled by #41.
 *
 * Important (ADR-0026 §6, blocker B-3): the server sync protocol ALREADY EXISTS.
 * #41 is a CLIENT-side adapter against the shipped endpoints, not new server
 * endpoints:
 *   - GET  /api/v1/projects/{pk}/sync/?since={server_version}
 *           → live rows + soft-deleted tombstones with server_version > since,
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

/** Result of a pull: the changes plus the new high-water `server_version`. */
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
  /** Pull rows with server_version greater than the local high-water mark. */
  pull(projectId: string, since: number): Promise<PullResult>;
  /** Push locally-queued changes (offline outbox) for a project. */
  push(projectId: string, changes: SyncChanges): Promise<void>;
}
