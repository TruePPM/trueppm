---
title: "Offline Sync"
description: "WatermelonDB-compatible delta protocol with soft-delete tombstones for mobile clients."
---

TruePPM's mobile client uses [WatermelonDB](https://watermelondb.dev/) as a local SQLite database. The sync endpoint provides a pull-only delta protocol compatible with WatermelonDB's `synchronize()` helper.

## Endpoint

```
GET /api/v1/projects/{project_id}/sync/?since={server_version}
Authorization: Bearer <token>
```

Any project member (Viewer+) may call this endpoint.

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

- `created` is always empty — WatermelonDB uses upsert semantics
- `updated` — full row objects for live (non-deleted) rows
- `deleted` — string IDs of soft-deleted rows (tombstones)
- `timestamp` — high-water mark to pass as `since` on the next pull

## server_version

Every synced model has a `server_version` field:

- Starts at `1` on INSERT
- Incremented atomically on every UPDATE via `F()` expression (no lost-update races)
- Soft-deleted rows get one final increment

`since=0` returns all rows (every row has `server_version ≥ 1`).

## TOCTOU safety

The server snapshots `max(server_version)` across all synced tables **before** running the delta queries. This prevents the race where a write lands between the version-snapshot and the row-queries, causing a row to be included in `updated` but the `timestamp` to be set too low — making the client miss it on the next sync.

## Soft delete

Deleting a resource sets `is_deleted = True`, increments `server_version`, and records `deleted_version`. The row is never physically removed. On the next sync, the ID appears in `deleted`; WatermelonDB removes the local record.

Task deletion cascades: all Dependency rows where the task is predecessor or successor are also soft-deleted. Mobile clients receive tombstones for both.

## WatermelonDB usage

```typescript
import { synchronize } from '@nozbe/watermelondb/sync';

await synchronize({
  database,
  pullChanges: async ({ lastPulledAt }) => {
    const res = await fetch(
      `/api/v1/projects/${projectId}/sync/?since=${lastPulledAt ?? 0}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const { changes, timestamp } = await res.json();
    return { changes, timestamp };
  },
  pushChanges: async () => {
    // Server-authoritative model — all mutations go via REST.
  },
});
```

## Collections

| Server model | WatermelonDB collection |
|-------------|------------------------|
| `Project` | `projects` |
| `Task` | `tasks` |
| `Dependency` | `dependencies` |
| `Calendar` | `calendars` |
| `ProjectMembership` | `memberships` |
