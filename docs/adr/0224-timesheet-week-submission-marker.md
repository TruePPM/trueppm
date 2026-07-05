# ADR-0224: Timesheet week-submission marker and the multi-entry grid-cell rule

## Status
Accepted

## Context

Issue **#1435** ships the contributor-facing **weekly cross-project timesheet grid** —
the "review + submit my week" companion to the per-task inline quick-log (#1234) and
running timer (#1415). The heavyweight governance machinery (manager approval workflow,
non-project categories, EVM actuals feed) stays in the 0.5 timesheet epic **#100**.

Nearly all of the backend already shipped in **#1258 / ADR-0185**:

- The grid **read** is `GET /api/v1/me/time-entries/?from=&to=` — the caller's entries in
  the window across every accessible project, plus precomputed `totals` (`by_day`,
  `by_cell` keyed `"<taskId>|<iso>"`, `today_minutes`, `week_minutes`). It is
  N+1-bounded (`select_related("task", "task__project")`) and membership-rechecked.
- Per-**cell writes** reuse the existing entry endpoints: create
  `POST /api/v1/tasks/{task_pk}/time-entries/`, edit `PATCH /api/v1/me/time-entries/{id}/`,
  clear `DELETE /api/v1/me/time-entries/{id}/` (soft delete).

ADR-0185 already names #1435 as *"weekly cross-project timesheet grid (entry +
**submit-marker**)"*, so two decisions remain open and belong here:

1. **The `Submit week` action.** Approval is #100 (0.5) and out of scope. Does 0.4 persist
   a submission at all, and if so with what shape?
2. **The multi-entry grid-cell rule.** `TimeEntry` deliberately has **no** uniqueness on
   `(user, task, entry_date)` — a contributor may log two sessions against the same task on
   the same day. The grid renders a `(task, date)` cell as a single summed value; editing
   that cell must map to concrete create/PATCH/DELETE calls without silently destroying the
   individual entries (their notes, `source=timer` provenance, `server_version` sync rows).

**P3M layer: Operations** (time entries) — OSS. A contributor marks *their own* week done.
There is no cross-project rollup, no approver, and no manager visibility — those governance
concerns live in #100 and, ultimately, Enterprise. Classification test ("would a PM/team
need this to run their program?") → yes, a contributor submitting their own time is
individual-contributor productivity, not governance → **OSS**.

## Decision

### 1. Submit week — option (a): a minimal per-user-per-week submission marker

Add a new `TimesheetSubmission` model:

| Field | Type | Notes |
|-------|------|-------|
| `id` | `UUIDField` PK | matches repo convention |
| `user` | `FK(AUTH_USER_MODEL)` | server-set to `request.user` (IDOR-safe by construction) |
| `week_start` | `DateField` | canonicalized to the **ISO Monday** (see below) |
| `submitted_at` | `DateTimeField` | set to `timezone.now()` on each (re)submit |

`Meta`: `UniqueConstraint(fields=["user", "week_start"])`, `db_table =
"timetracking_timesheet_submission"`, index `["user", "week_start"]` (covered by the
unique constraint).

**Not a `VersionedModel` / not sync-eligible** — the same call ADR-0185 made for
`ActiveTimer`. The marker is an inherently **online** action on a **web-first** surface
(#1435 is the *"web precursor to 0.4 mobile"*); it carries no field a client edits offline,
so wrapping it in WatermelonDB version/tombstone machinery would churn sync for a
boolean-shaped signal. It is forward-compatible: when #100 adds the approval state machine
(Submitted → Approved / Returned), the row's *existence + `submitted_at`* is the "Submitted"
signal a governance layer reads or extends — no rename, no data migration of `TimeEntry`.

**`week_start` canonicalization.** The server **normalizes** the path date to the Monday of
its ISO week: `week_start = posted - timedelta(days=posted.weekday())`. Normalizing (rather
than rejecting a non-Monday with 400) is forgiving of client drift and makes it *impossible*
to fragment the `(user, week_start)` space into off-by-a-day rows. The grid always anchors to
Monday, so in practice the posted date is already a Monday.

**Endpoints** — a single action-style view, hard-scoped to `request.user`:

- `POST /api/v1/me/timesheets/{week_start}/submit` → `200 {week_start, submitted_at}`.
  Idempotent upsert (`update_or_create`) — a retried submit just refreshes `submitted_at`.
- `DELETE /api/v1/me/timesheets/{week_start}/submit` → `204`. Un-submit (removes the marker),
  idempotent (204 even when none exists). Included because entries **stay editable** after
  submit; without un-submit a fat-fingered Submit would strand the week showing "submitted"
  forever. This is the whole state machine 0.4 ships — no approver, no lock, no return.

**Reading submission state — folded into the weekly GET** to avoid a second round-trip. The
weekly response gains a top-level `submission` key computed from the Monday of `from`:

```json
{ "results": [ ... ], "totals": { ... },
  "submission": { "week_start": "2026-06-15", "submitted": true, "submitted_at": "2026-06-20T17:04:00Z" } }
```

One extra indexed lookup, no per-row cost. The grid always requests a full Mon–Sun window,
so `submission.week_start` is well-defined.

**RBAC.** `IsAuthenticated` only; the row is hard-scoped to `request.user` (like
`MeTimeEntryDetailView`), so it is IDOR-safe by construction — there is no task or project in
the request to gate with `CanLogTime`. A pure Viewer *can* create a marker for their own
(entry-less) week; this is harmless — the marker is inert without entries and exposes no other
user's data. Documented rather than special-cased.

### 2. Multi-entry grid-cell rule

The grid cell shows the **sum** (`totals.by_cell["<taskId>|<iso>"]`). `useTimesheetCell()`
maps an edit against the entries the weekly `results` already carries for that `(task, date)`:

| Entries in cell | Grid behaviour |
|-----------------|----------------|
| **0** | typing hours → `POST tasks/{task}/time-entries/` (create) |
| **exactly 1** | typing hours → `PATCH me/time-entries/{id}/` (`minutes`); clearing → `DELETE` |
| **≥ 2** | **read-only sum** — cell renders the total with a subtle multi-entry dot + tooltip *"2 entries · edit on My Work"*; not directly editable in the grid |

The `≥2` cell is deliberately **non-destructive read-only**, not "replace-all". A replace-all
(delete N, create 1) would silently discard per-entry notes, `source=timer` provenance, and
the individual `server_version` sync rows — a surprising data loss for a grid edit. Splitting a
summed cell back into N entries is unrepresentable in a single number, so the grid defers
multi-entry editing to My Work (#1234), where the individual rows are visible. This is the
least-surprising, cheapest-to-ship, correctness-preserving rule.

Hours parsing is client-side (`2` → 120, `2.5` → 150, `2:30` → 150; empty/`0` → clear); the
server stores canonical integer `minutes` (1..1440) exactly as it does today.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **(a) submission marker** (chosen) | `Submit week` has real meaning in 0.4; #100 layers approval on top with no `TimeEntry` change; cheap (one tiny model) | one new model + migration |
| (b) defer submission to #100 | zero backend | the design's primary header action is a no-op in 0.4 beta; button-that-does-nothing is worse than absent |
| Marker as `VersionedModel` (synced) | offline submit on mobile | sync churn + tombstones for a boolean; submit is inherently online; #1435 is web-first |
| Multi-entry cell = replace-all | cell always editable | silently destroys notes / timer provenance / sync rows — data loss |
| Multi-entry cell = edit first entry only | always editable | edits one hidden row while the cell shows the sum — misleading |

## Consequences

- **Easier:** the `Submit week` button persists a truthful, queryable per-week signal; #100's
  approval workflow reads/extends `TimesheetSubmission` without migrating `TimeEntry`. The
  grid's write path is a thin mapping over endpoints that already exist and are already tested.
- **Harder:** contributors with ≥2 entries in one `(task, date)` cell must edit on My Work, not
  in the grid — a documented, intentional limitation (surfaced by the cell's affordance).
- **Risks:** the folded `submission` key couples the weekly GET's response to week semantics
  when `from` is the Monday of a week; mitigated because the grid is the only caller that reads
  the key and it always sends a full week. The header rollup (#1234) ignores the key.

## Implementation Notes
- **P3M layer:** Operations — OSS.
- **Affected packages:** api (new model/serializer/view/migration + one weekly-GET field), web
  (hooks + grid page + route/nav). No scheduler, no mobile, no helm.
- **Migration required:** yes — one migration, one new model (`makemigrations timetracking`
  once, then `ruff check --fix && ruff format` per the migration recipe).
- **API changes:** yes — `POST`/`DELETE /me/timesheets/{week_start}/submit`; `submission` key
  added to `GET /me/time-entries/`. Regenerate `docs/api/openapi.json`.
- **OSS or Enterprise:** OSS (`trueppm-suite`). No `trueppm_enterprise` import.

### Durable Execution
1. **Broker-down behaviour:** N/A — submit/un-submit is a single synchronous DB
   `update_or_create` / `delete` with no async side effect; no `.delay()` to lose, no outbox.
2. **Drain task:** N/A — no async category introduced.
3. **Orphan window:** N/A — no `on_commit`-dispatched work and no broadcast (a personal
   submission marker mutates no shared board state, mirroring ADR-0185 §5).
4. **Service layer:** trivial enough to live in the view (`update_or_create` / `delete`); no
   `services.py` function or `enqueue_*` interaction — submission never touches `Task` dates or
   triggers a CPM recompute.
5. **API response on best-effort dispatch:** N/A — responses are synchronous (`200`/`204`);
   nothing is queued, so nothing returns `{"queued": true}`.
6. **Outbox cleanup:** N/A — no outbox. A `TimesheetSubmission` is hard-deleted on un-submit
   (no tombstone: not sync-eligible), so there is no retention job.
7. **Idempotency:** submit is `update_or_create` on the `(user, week_start)` unique constraint —
   a duplicate POST refreshes `submitted_at`, never a second row. Un-submit is a scoped
   `.delete()` — a second DELETE finds nothing and still returns `204`.
8. **Dead-letter / failure handling:** N/A — synchronous writes surface validation (`400`) and
   auth (`401`) inline; no task to dead-letter, nothing to retry.
