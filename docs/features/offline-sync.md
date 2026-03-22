# Offline Sync

TruePPM's mobile client uses [WatermelonDB](https://watermelondb.dev/) as a local SQLite database. The sync endpoint provides a pull-only delta protocol compatible with WatermelonDB's `synchronize()` helper.

## Endpoint

```
GET /api/v1/projects/{project_id}/sync/?since={server_version}
Authorization: Bearer <token>
```

Any project member (Viewer and above) may call this endpoint. Authentication is required.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | integer | `0` | Return rows with `server_version > since`. Use `0` for a full sync. |

## Response

```json
{
  "changes": {
    "projects":     { "created": [], "updated": [...], "deleted": [...] },
    "tasks":        { "created": [], "updated": [...], "deleted": [...] },
    "dependencies": { "created": [], "updated": [...], "deleted": [...] },
    "calendars":    { "created": [], "updated": [...], "deleted": [...] },
    "memberships":  { "created": [], "updated": [...], "deleted": [...] }
  },
  "timestamp": 42
}
```

- `created` is always empty — WatermelonDB uses upsert semantics, so inserts and updates both appear in `updated`
- `updated` contains full serialised row objects for live (non-deleted) rows
- `deleted` contains string IDs of soft-deleted rows (tombstones)
- `timestamp` is the high-water mark to pass as `since` on the next pull

## Server version

Every synced model has a `server_version` field:

- Starts at `1` on INSERT
- Incremented atomically on every UPDATE via a `F()` expression (no lost-update races)
- Soft-deleted rows increment once more and set `is_deleted = True`

`since=0` returns all live rows (every row has `server_version ≥ 1`) plus tombstones for any rows soft-deleted since the beginning of time.

## TOCTOU safety

The server snapshots `max(server_version)` across all synced tables **before** running the delta queries, inside a `REPEATABLE READ` transaction. This eliminates the race condition where:

1. Server reads `max_version = 10`
2. A concurrent write creates a row with `server_version = 11`
3. Server queries `server_version > 0` — the new row is included in `updated`
4. Server returns `timestamp = 10`
5. Client's next `since=10` misses the row created in step 2 (it has `server_version = 11 > 10`)

By snapshotting the high-water mark first, the `timestamp` returned always covers all rows included in the current response. The client will see any writes that happened between syncs on the next pull.

## Soft delete

Deleting a resource in TruePPM does not remove the database row. Instead:

1. `is_deleted` is set to `True`
2. `server_version` is incremented (the deleted row now has a new version)
3. `deleted_version` records the version at which the deletion occurred

On the next sync pull, the row appears in the `deleted` array as a tombstone ID. WatermelonDB removes the corresponding local record.

Task deletion cascades: when a Task is soft-deleted, all Dependency rows where it is either predecessor or successor are also soft-deleted. Mobile clients receive tombstones for both the task and its edges.

## Usage with WatermelonDB

```typescript
import { synchronize } from '@nozbe/watermelondb/sync';

await synchronize({
  database,
  pullChanges: async ({ lastPulledAt }) => {
    const response = await fetch(
      `/api/v1/projects/${projectId}/sync/?since=${lastPulledAt ?? 0}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const { changes, timestamp } = await response.json();
    return { changes, timestamp };
  },
  pushChanges: async () => {
    // TruePPM uses a server-authoritative model.
    // All mutations go through the REST API directly; push is a no-op.
  },
});
```

## Collections

The following server-side models map to WatermelonDB collections:

| Server model | Collection |
|-------------|------------|
| `Project` | `projects` |
| `Task` | `tasks` |
| `Dependency` | `dependencies` |
| `Calendar` | `calendars` |
| `ProjectMembership` | `memberships` |
