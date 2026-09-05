/**
 * Offline data-layer boundary (ADR-0026 §Data layer). This is an EMPTY TYPED
 * BOUNDARY — the concrete WatermelonDB schema + models are filled by #41
 * (blocked-by this scaffold). It declares only the server contract every synced
 * record must satisfy so the sync engine and feature code can be written against
 * a stable type today.
 *
 * Every synced entity mirrors the server `VersionedModel` contract:
 *   - id           UUID primary key (string on the client)
 *   - server_version  this row's own save count — the optimistic-lock token sent
 *                  back as `X-Base-Version`. NOT the pull cursor: the delta pages
 *                  on the server-side `sync_seq` (ADR-0686), which is not
 *                  serialized to clients. Echo the response `timestamp` verbatim.
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

/**
 * Collections the project delta returns, in the server's fixed protocol order
 * (`ProjectSyncView.sources`, `apps/sync/views.py`). The pager drains them in
 * this order and the order is part of the protocol — mirror it, do not sort.
 *
 * HAND-MAINTAINED, and therefore able to drift: the scaffold shipped
 * `project_members` (the server calls it `memberships`) and only 3 of the 15
 * names. It cannot yet be derived — `SyncPullResponse.changes` is
 * `additionalProperties: {}` in `docs/api/openapi.json`, so the pull collection
 * keys are not published. Deriving this union is blocked on the server naming
 * them in the schema; until then, re-check this list against `views.py`
 * whenever you touch it.
 *
 * `programs` / `program_memberships` are NOT here: they come from the separate
 * user-program endpoint (`UserProgramSyncView`, `GET /api/v1/sync/user/programs/`),
 * not the project delta.
 */
export type SyncedTable =
  | 'projects'
  | 'tasks'
  | 'dependencies'
  | 'calendars'
  | 'memberships'
  | 'risks'
  | 'sprints'
  | 'sprint_retros'
  | 'retro_action_items'
  | 'task_suggested_assignees'
  | 'task_links'
  | 'task_recurrence_rules'
  | 'time_entries'
  | 'labels'
  | 'task_relations';
