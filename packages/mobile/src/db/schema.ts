/**
 * Offline data-layer boundary (ADR-0026 §Data layer). This is an EMPTY TYPED
 * BOUNDARY — the concrete WatermelonDB schema + models are filled by #41
 * (blocked-by this scaffold). It declares only the server contract every synced
 * record must satisfy so the sync engine and feature code can be written against
 * a stable type today.
 *
 * Every synced entity mirrors the server `VersionedModel` contract:
 *   - id           UUID primary key (string on the client)
 *   - server_version  monotonic BigInt; the cursor the pull protocol pages on
 *   - is_deleted   tombstone flag (soft-delete; rows are never hard-deleted so
 *                  deletions propagate to every client)
 */

/** The three fields every WatermelonDB-synced table mirrors from the server. */
export interface VersionedRecord {
  id: string;
  /** Server-assigned monotonic version. `bigint`-valued; carried as number on
   *  the client (JS-safe for the version magnitudes TruePPM emits). */
  server_version: number;
  is_deleted: boolean;
}

/** Synced table names the WatermelonDB schema (#41) will register. Kept here so
 *  the sync engine's scope handling has a typed surface before the schema lands. */
export type SyncedTable = 'projects' | 'tasks' | 'time_entries' | 'project_members';
