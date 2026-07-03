---
title: "Offline Sync"
description: "WatermelonDB-compatible delta protocol with soft-delete tombstones for mobile clients."
---

TruePPM's mobile client uses [WatermelonDB](https://watermelondb.dev/) as a local SQLite database. The sync endpoint provides a two-way delta protocol compatible with WatermelonDB's `synchronize()` helper: `GET` pulls server changes since a watermark, and `POST` uploads a batch of local task mutations.

## Pull endpoint

```
GET /api/v1/projects/{project_id}/sync/?since={server_version}
Authorization: Bearer <token>
```

Any project member (Viewer+) may call this endpoint.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | integer | `0` | Return rows with `server_version > since`. Use `0` for a full sync. Keep constant for the whole paging session. |
| `cursor` | string | — | Opaque continuation token for the next page. Omit on the first request; pass the previous response's `next_cursor` on each subsequent one. |
| `page_size` | integer | `TRUEPPM_SYNC_PULL_PAGE_SIZE` (1000) | Maximum rows returned across all collections in one page. Clamped to `TRUEPPM_SYNC_PULL_MAX_PAGE_SIZE` (5000). |

## Response

```json
{
  "changes": {
    "projects":               { "created": [], "updated": [...], "deleted": [...] },
    "tasks":                  { "created": [], "updated": [...], "deleted": [...] },
    "dependencies":           { "created": [], "updated": [...], "deleted": [...] },
    "calendars":              { "created": [], "updated": [...], "deleted": [...] },
    "memberships":            { "created": [], "updated": [...], "deleted": [...] },
    "risks":                  { "created": [], "updated": [...], "deleted": [...] },
    "sprints":                { "created": [], "updated": [...], "deleted": [...] },
    "sprint_retros":          { "created": [], "updated": [...], "deleted": [...] },
    "retro_action_items":     { "created": [], "updated": [...], "deleted": [...] },
    "task_suggested_assignees": { "created": [], "updated": [...], "deleted": [...] },
    "task_links":             { "created": [], "updated": [...], "deleted": [...] },
    "task_recurrence_rules":  { "created": [], "updated": [...], "deleted": [...] },
    "time_entries":           { "created": [], "updated": [...], "deleted": [...] }
  },
  "timestamp": 42,
  "next_cursor": "eyJpIjoxLCJ2IjoxLCJpZCI6Ii4uLiJ9",
  "has_more": true
}
```

- `created` is always empty — WatermelonDB uses upsert semantics
- `updated` — full row objects for live (non-deleted) rows
- `deleted` — string IDs of soft-deleted rows (tombstones)
- `timestamp` — high-water mark to adopt as `since` **after** the delta is fully drained
- `next_cursor` — opaque continuation token, or `null` when the delta is exhausted
- `has_more` — `true` while more pages remain for this `since` session

## Pagination

The pull is **cursor-paginated** so a cold start (`since=0`) on a large project never materializes the whole project into one unbounded response. Each page carries at most `page_size` rows across all collections; the client loops until the delta is drained:

1. Request the first page with `since` (no `cursor`).
2. Apply the page's `changes`.
3. If `has_more` is `true`, request again with the same `since` and the returned `next_cursor`.
4. When `has_more` is `false` (`next_cursor` is `null`), the session is complete — adopt `timestamp` as the `since` for the next sync.

The cursor is a **compound keyset** on `(collection, server_version, id)`, not a scalar `server_version` ceiling. This is required because `server_version` is a per-row edit counter, not a global sequence: on a cold start every freshly created row shares `server_version = 1`. A scalar version cursor could not split a page between two rows of the same version without either dropping rows or leaving the page unbounded. Keying on the row `id` (a unique UUID) as a tiebreak makes every page boundary unambiguous — **no row is skipped and no row is duplicated**, even when thousands of rows share a version. Because `server_version` only ever increases, a row edited mid-session moves forward in the stream and is either delivered later or re-delivered under upsert — never lost.

Retro rows are visibility-filtered (ADR-0071): a Viewer pulling a project whose retros are **team-only** does not receive the retro's raw notes or action-item text — those rows are excluded at the queryset level, and tombstones are delivered for visibility-removed rows so the local database drops them.

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

## Upload endpoint

```
POST /api/v1/projects/{project_id}/sync/
Authorization: Bearer <token>
```

Uploads a WatermelonDB-shaped delta batch (ADR-0082). The request body is an envelope:

```json
{
  "client_batch_id": "<uuid>",
  "last_pulled_at": 42,
  "changes": {
    "tasks": { "created": [...], "updated": [...], "deleted": [...] }
  }
}
```

- **Writable surface** — only the `tasks` collection may be uploaded in v1; any other collection key is rejected with 400. All other mutations go via REST.
- **Idempotent replay** — `client_batch_id` is a client-generated UUID. The first request to apply the batch records it and its response atomically; a retry carrying the same id (within the retention window, default 24 hours) replays the stored response without re-applying. Safe against flaky mobile networks.
- **All-or-nothing** — the whole batch applies inside one transaction. A row that fails validation or RBAC rejects the entire batch.
- **Same rules as REST** — apply reuses the same serializer as `PATCH /tasks/{id}/`, so an upload can never do something the caller could not do over REST. Requires at least the Team Member role; archived projects are rejected.
- **Conflict resolution** — plain last-writer-wins; each row is applied unconditionally and `server_version` is bumped.
- **Limits** — the POST path is rate-throttled, and a batch is capped at 500 rows by default (`TRUEPPM_SYNC_BATCH_MAX_ROWS`).

## WatermelonDB usage

```typescript
import { synchronize } from '@nozbe/watermelondb/sync';

await synchronize({
  database,
  pullChanges: async ({ lastPulledAt }) => {
    // Loop the cursor until the delta is drained, merging each page's buckets.
    const since = lastPulledAt ?? 0;
    const merged: Record<string, { created: unknown[]; updated: unknown[]; deleted: string[] }> = {};
    let cursor: string | null = null;
    let timestamp = since;
    do {
      const url = new URL(`/api/v1/projects/${projectId}/sync/`, location.origin);
      url.searchParams.set('since', String(since));
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const page = await res.json();
      for (const [collection, bucket] of Object.entries(page.changes)) {
        const dst = (merged[collection] ??= { created: [], updated: [], deleted: [] });
        dst.updated.push(...bucket.updated);
        dst.deleted.push(...bucket.deleted);
      }
      timestamp = page.timestamp;
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return { changes: merged, timestamp };
  },
  pushChanges: async ({ changes, lastPulledAt }) => {
    // Only the `tasks` collection is uploadable in v1; other mutations go via REST.
    await fetch(`/api/v1/projects/${projectId}/sync/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Persist the batch id with the queued batch so a retry after a
        // network failure replays idempotently instead of re-applying.
        client_batch_id: crypto.randomUUID(),
        last_pulled_at: lastPulledAt ?? 0,
        changes: { tasks: changes.tasks },
      }),
    });
  },
});
```

## Collections

| Server model | WatermelonDB collection | Uploadable |
|-------------|------------------------|------------|
| `Project` | `projects` | — |
| `Task` | `tasks` | ✅ |
| `Dependency` | `dependencies` | — |
| `Calendar` | `calendars` | — |
| `ProjectMembership` | `memberships` | — |
| `Risk` | `risks` | — |
| `Sprint` | `sprints` | — |
| `SprintRetro` | `sprint_retros` | — |
| `RetroActionItem` | `retro_action_items` | — |
| `TaskSuggestedAssignee` | `task_suggested_assignees` | — |
| `TaskLink` | `task_links` | — |
| `TaskRecurrenceRule` | `task_recurrence_rules` | — |
| `TimeEntry` | `time_entries` | — |
