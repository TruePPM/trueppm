# ADR-0201: Unified Project Changelog

## Status
Accepted

## Context

Every persona and every demo asks the same question: *"show me what changed in the
last week."* Today the answer is scattered across per-object surfaces — the per-task
history drawer (ADR-0011, ADR-0096), the project-level history list
(`ProjectHistoryListView`, project fields only), and the board-scoped activity feed
(ADR-0160, board card mutations only). No single surface answers "what changed across
*this whole project*, across *every* object type, newest-first, filterable."

The data already exists: `django-simple-history` captures field-level history on nine
project-scoped models (Task, Sprint, Risk, Project, Dependency, TaskRecurrenceRule, and
the three singleton policy models — Guardrail, SignalPrivacy, Decisions). The problem is
purely one of **aggregation, ordering, stable pagination, and permission-aware
filtering** across heterogeneous historical tables.

Three hard problems drive the design:

1. **Aggregation across ~9 heterogeneous historical tables.** The tables have different
   columns, so a single SQL `UNION` is impractical (and fragile against schema drift).
2. **A stable cursor across a cross-table merge.** `history_date` is a timestamp and can
   collide across tables; `history_id` is only unique *within* a table. A naive
   timestamp-only cursor (the `until` cursor used by ADR-0011/0160) is **lossy** across
   ties spanning object types — exactly what the issue warns against.
3. **Permission-aware row filtering** that stays correct under pagination (filter in the
   queryset, never post-filter a page).

**P3M layer.** Programs and Projects → **OSS**. This is a single-project "what changed"
view a PM/team needs to run their program; it aggregates *within* one project, never
across projects. The cross-portfolio digest and the immutable/cryptographic audit trail
remain **Enterprise** (ADR-0157: OSS emits mutable, human-readable history; the signed
chain is Enterprise). The VoC panel confirmed this split — Marcus's cross-portfolio 🔴 is
expected-by-design, while the load-bearing OSS/API personas (Jordan PO, Alex SM, Nadia
API) all want exactly this project-scoped, documented, stably-paginated feed.

## Decision

Add a read-only endpoint `GET /api/v1/projects/{project_pk}/changelog/` in the existing
`history` app, aggregating the nine project-scoped historical tables into one
newest-first stream with a **strict-total-order keyset cursor** and permission-aware
filtering.

### Aggregation — bounded per-source fetch + Python k-way merge

Reject SQL `UNION` (heterogeneous schemas). Instead, mirror the proven ADR-0160
`build_board_activity` shape but generalize it to all nine sources and fix its cursor:

- Each source is one `Historical*` queryset, project-scoped by its own path
  (`project_id=` for the direct-FK models; `predecessor__project_id=` for Dependency;
  `task__project_id=` for TaskRecurrenceRule; `pk=project_pk` for Project itself).
- Each source is fetched `ORDER BY history_date DESC, history_id DESC` with
  `LIMIT page_size + 1` (the `+1` is the lookahead that tells us the *global* stream has
  more beyond this page). This bounds the per-request scan — never "fan out a query per
  row," never materialize a whole table.
- The nine bounded lists are merged in Python on the total-order key (below) and the
  first `page_size` rows form the page.

Diffs are computed within the fetched batch by pairing each row against the next-older
row *of the same object* in the same batch (the ADR-0011/0096 `_build_prev_map`
technique — no per-row `prev_record` query, no N+1). The documented edge (inherited from
ADR-0160): a change whose prior row fell outside the batch surfaces with an empty
`changes` list.

### Cursor — strict total order `(history_date, table_rank, history_id)`

`history_date` alone is not a total order (timestamps collide across tables), and
`history_id` is unique only within a table. The strict total order is the triple
**`(history_date DESC, table_rank ASC, history_id DESC)`**, where `table_rank` is a fixed
integer assigned to each source (stable position in the source list). This disambiguates
two rows in *different* tables that share an exact `history_date`, and `history_id`
disambiguates two rows in the *same* table.

The cursor is an opaque base64-urlsafe JSON token `{d, r, id}` (ISO date, rank,
history_id), reusing the `SyncCursor` encode/decode/validation idiom from
`sync/pagination.py` (a tampered/truncated token yields 400, never 500). "Next page" =
rows strictly *after* the cursor in the newest-first order. For a source with fixed rank
`r` and cursor `(cd, cr, cid)`, the per-source filter is:

```
if r > cr:   history_date < cd  OR  history_date == cd                       # all same-date rows are older
if r == cr:  history_date < cd  OR (history_date == cd AND history_id < cid)  # tie-break within the table
if r < cr:   history_date < cd                                               # same-date rows here are newer → already sent
```

This is a rigorous, provably gap-free and duplicate-free partition of the global stream
(the same guarantee `sync/pagination.py` documents for `(server_version, id)`), and it is
stable under concurrent writes: a newer row inserted mid-scroll sorts *ahead* of the
cursor and is simply not on a later page (no skip of an already-past row).

### Permission strategy — membership gate + queryset scope + field/user redaction

Object-level investigation confirmed **every one of the nine sources is readable by any
project member (Viewer+)** — each live GET endpoint uses `IsProjectMember`; only *writes*
are role-gated. There is **no per-user, sub-project row ACL** on any of these models
(TimeEntry and Retrospective are per-user/private but are *not* in the historical source
set, so they cannot leak here). Therefore:

- **Gate:** `IsAuthenticated + IsProjectMember` (Viewer+). A non-member is rejected before
  any row is read. (`IsProjectNotArchived` is deliberately omitted — history is a
  read-only audit surface that stays readable after archive, matching
  `ProjectHistoryListView`.)
- **Row inclusion:** membership is sufficient; each source is scoped by `project_id` (or
  its join path) *in the queryset*, so pagination counts are always correct — pages are
  never post-filtered.
- **Field redaction:** reuse the history app's `_DIFF_EXCLUDED` set, which already
  excludes CPM outputs, sync internals, and — per ADR-0124 — `blocked_reason` (contributor
  voice, never in a team-readable diff).
- **`history_user` redaction (Morgan's surveillance concern):** reuse
  `_caller_can_see_user` — `history_user` is returned only to Owner/Admin (≥ `Role.ADMIN`);
  lower roles get `null`. The `user=` **filter** is likewise honored only for callers who
  can see users (Admin/Owner); for lower roles it is ignored, so the feed can never be
  turned into a per-person activity tracker by a Viewer-tier PMO reader. This directly
  answers the VoC 🟡 without removing the audit value Jordan/Alex want (they are Admin+ on
  their own projects).

### Filters

`since` (inclusive `history_date >=`), `object_type` (comma list → restrict the source
set), `change_type` (`created|updated|deleted` → history_type `+`/`~`/`-`), `user`
(history_user id, Admin+ only). All are expressed as queryset `WHERE` clauses (filter,
then paginate — never post-filter).

### Indexes

`HistoricalTask` already carries `(project_id, history_date)` (migration 0090). Add the
same composite to the two other higher-volume project-FK tables — `HistoricalSprint` and
`HistoricalRisk` — via a raw `CREATE INDEX` migration (no `models.py` change; mirrors
0090's `CONCURRENTLY`, `IF NOT EXISTS`, `atomic=False` recipe). `HistoricalProject` is
filtered by PK (`id`) and is low-volume; the three policy tables are singletons (a handful
of rows per project); Dependency is join-scoped and bounded by the per-source `LIMIT` — none
of these warrant an index.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **SQL `UNION ALL` across 9 historical tables** | One query, DB-side sort/paginate | Heterogeneous columns force a lowest-common-denominator projection; brittle against schema drift; hard to express the diff-vs-prior pairing; still needs the same total-order cursor |
| **Timestamp-only `until` cursor (ADR-0011/0160 idiom)** | Simplest; matches existing feeds | **Lossy across cross-table `history_date` ties** — the exact defect the issue calls out. Fine for a single-table board feed, wrong for a 9-way merge |
| **Bounded per-source fetch + Python k-way merge + `(date, rank, id)` keyset** (chosen) | Correct total order, provably no dup/skip, bounded scan, reuses `SyncCursor` + `_build_prev_map` precedents, robust to schema drift | Merge is O(page × sources) in Python (trivial at page sizes ≤ 100); a diff whose prior row is outside the batch shows empty changes (documented, inherited from ADR-0160) |
| **New denormalized `ChangelogEntry` table populated by signals** | Single-table pagination, trivial cursor | Duplicates data already in the historical tables; a write path + backfill + drain to maintain; contradicts "the data is already captured"; larger blast radius |

## Consequences

- **Easier:** one project-wide "what changed" surface; a documented, stable, opaque cursor
  that integration authors (Nadia) can poll safely; a deep-linkable filtered URL a PM can
  paste into Slack.
- **Harder:** adding a new historical model to the project means registering it as a source
  (one entry in the source list) — a small, explicit seam, not automatic.
- **Risks:** (a) the empty-`changes` deep-page edge (mitigated: it is a display nuance, not
  a correctness bug — the row still appears with its type/actor/timestamp); (b) a very busy
  project scans up to `(page_size+1) × 9` historical rows per page — bounded and
  index-assisted, well within the "recent activity" use case; (c) the cursor encodes a
  `table_rank` tied to source-list position — the list order must stay stable (documented
  in code; reordering it would invalidate in-flight cursors, acceptable for an opaque,
  short-lived pagination token).

## Implementation Notes

- P3M layer: **Programs and Projects** (single-project aggregation).
- Affected packages: **api** (new endpoint in the `history` app + one index migration),
  **web** (new Activity tab, filter chips, infinite scroll, deep-link, click-through).
- Migration required: **yes** — additive raw `CREATE INDEX` only (no model field change,
  no data migration, non-destructive).
- API changes: **yes** — one new read-only endpoint
  `GET /api/v1/projects/{project_pk}/changelog/`. Published in the versioned OpenAPI
  schema with the cursor + error contract documented (Nadia's ask).
- OSS or Enterprise: **OSS** (`trueppm-suite`). Cross-portfolio digest and immutable
  cryptographic audit remain Enterprise.

### Durable Execution
1. Broker-down behaviour: **N/A** — read-only GET endpoint, zero async side effects, no
   task dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no `transaction.on_commit()` dispatch.
4. Service layer: aggregation lives in a new pure function
   `history/changelog.py::build_project_changelog(...)` (no dispatch — a query+merge
   helper, the ADR-0160 `build_board_activity` analog).
5. API response on best-effort dispatch: **N/A** — synchronous `200 {results, next_cursor}`.
6. Outbox cleanup: **N/A** — no outbox rows written.
7. Idempotency: **N/A for writes**; the GET is naturally idempotent and side-effect-free.
   The cursor is a pure function of `(history_date, table_rank, history_id)`, so replaying
   a request with the same cursor returns the same page.
8. Dead-letter / failure handling: **N/A** — no background task. A malformed cursor or
   filter value returns a `400` with a field-scoped message; a non-member returns `403`.
