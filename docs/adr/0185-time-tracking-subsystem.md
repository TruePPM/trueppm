# ADR-0185: Time-tracking subsystem — TimeEntry, running timer, and the `can_log_time` gate

## Status
Accepted

## Context

TruePPM advertises **time tracking** as a community-edition capability (the feature
list in `CLAUDE.md`; the Team Member role reads *"Can log time"* in `RolePicker.tsx`,
`WorkspaceRolesPage.tsx`, and `lib/roles.ts`). The capability does not exist. A
repo-wide search finds no `TimeEntry`/`TimeLog`/`WorkLog` model, no time-entry
serializer/viewset/endpoint, and no web hook. The only time-shaped fields on a task
are `Task.actual_start` / `Task.actual_finish` — coarse **status-transition dates**
(`apps/projects/models.py:1361-1362`), not logged effort. "Log time" is aspirational
copy.

This ADR is the **keystone foundation** for the 0.4 web contributor time-entry family
(umbrella **#926**). It defines the data model, permission gate, endpoint contract, and
sync/broadcast posture that four downstream UI issues consume but do not re-decide:

- **#1234** — My Work inline quick-log popover (preset chips + hours + undo toast).
- **#1415** — running header timer (start/stop chip persisted server-side).
- **#1416** — global "Log time" quick-log popover (task picker + presets).
- **#1435** — weekly cross-project timesheet grid (entry + submit-marker).

**P3M layer: Operations** (time entries, deliverables) — OSS. A contributor records
*their own* effort against tasks they can access. There is no cross-project rollup, no
approval workflow, and no per-user time visibility for managers — those are the
governance concerns that live in the 0.5 timesheet epic **#100** and, ultimately,
Enterprise. The classification test ("would a PM/team need this to run their program?")
answers OSS: a team member logging a day's work is table-stakes contributor
productivity, not portfolio governance.

Prior planning (#926/#1258 threads) proposed four constraints. This ADR **validates**
three and **refines** the fourth:

- `TimeEntry` as a `VersionedModel` — **confirmed** (sync-eligible for mobile #25/#83,
  PWA #1393).
- Duration stored as integer **minutes** — **confirmed** (avoids decimal-hours drift).
- A `can_log_time` gate aligned with **ADR-0133** — **confirmed and made concrete**:
  this is the deliberate capability split ADR-0133 anticipated, because the time-log
  rule genuinely diverges from the task-edit rule (see Decision §3).
- The running timer as "a singleton record **or** an unfinalized `TimeEntry`" —
  **decided in favor of a dedicated, non-versioned `ActiveTimer` record** (see
  Decision §2), rejecting the unfinalized-`TimeEntry` option.

### Forces

1. **Apache 2.0 boundary** — fully OSS; no `trueppm_enterprise` import.
2. **Offline-first** — mobile must queue and reconcile entries, so the model must carry
   `server_version` + soft-delete tombstones and participate in the delta pull.
3. **API-first** — every surface (web, mobile, MCP) is a REST consumer; the contract
   here is the single source of truth.
4. **No surveillance surface** — the codebase's `/me/work/` endpoint hard-scopes to
   `request.user` with no `?user=` escape hatch (the "Morgan sprint-sovereignty"
   requirement). Time entries are more sensitive than tasks; the same discipline applies
   — a Member never reads a colleague's entries through any 0.4 endpoint.

## Decision

### 1. New Django app `apps/timetracking` is the home

Create a new domain app `trueppm_api.apps.timetracking` rather than extending
`apps/projects` or `apps/resources`.

- **`CLAUDE.md` convention is "one app per domain."** Time tracking is a cohesive domain
  (entry, timer, weekly read, and — later — the #100 approval/EVM layer registers here).
  Co-locating in `apps/projects` (already ~9k lines of `models.py`) buries it; placing it
  in `apps/resources` mis-frames it (resources model *capacity/skills/assignment*, a
  Scheduler concern, not contributor *actuals*).
- **It is the registration point the family grows into.** #1435's submit-marker, the
  #100 approval state machine, and the EVM actuals feed all attach to this domain. A
  dedicated app keeps that surface area discoverable and lets the OSS↔Enterprise seam
  (the future approval/audit layer) sit at an app boundary.
- **No circular-import cost.** `timetracking` imports `Task`/`Project` from `projects`
  and the RBAC helpers from `access`; nothing in `projects`/`access` imports back. The
  `can_user_log_time` predicate is co-located in `apps/access/permissions.py` next to
  `can_user_edit_task` (same anti-cycle reasoning as ADR-0133 §1 — the predicate needs
  `_membership_role`/`Role`, which already live there).

This is the **primary architectural decision and an open question for Kelly** (see
Blockers). The recommendation is `apps/timetracking`.

### 2. `TimeEntry` (versioned, logged fact) + `ActiveTimer` (non-versioned, live state)

Two models with different lifecycles — a deliberate split, not one model with a nullable
duration.

**`TimeEntry(VersionedModel)` — the durable logged fact** (`db_table = "timetracking_time_entry"`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUIDField PK | from `VersionedModel` |
| `server_version` / `is_deleted` / `deleted_version` | from `VersionedModel` | sync + tombstones |
| `task` | FK → `projects.Task`, `on_delete=CASCADE` | the work the time is against |
| `user` | FK → `AUTH_USER_MODEL`, `on_delete=CASCADE` | **server-set to `request.user`**, never client-supplied |
| `minutes` | `PositiveIntegerField`, validators `[MinValueValidator(1), MaxValueValidator(1440)]` | canonical unit; one entry ≤ 24 h |
| `entry_date` | `DateField`, default = today (caller TZ) | the day the work happened |
| `note` | `CharField(max_length=500, blank=True)` | optional |
| `source` | `CharField(choices=manual\|timer, default=manual)` | provenance for the UI/undo |
| `created_at` | `DateTimeField(auto_now_add=True)` | |

`Meta` (indexes/constraints regenerable, **no `RunSQL`**):
- `Index(fields=["user", "entry_date"])` — header today/week rollup + weekly grid read.
- `Index(fields=["user", "task", "entry_date"])` — grid cell `(task, date)` upsert.
- `Index(fields=["task", "server_version"])` — project sync delta pull.
- `is_deleted` is already `db_index=True` on the base.

No `UniqueConstraint` on `(user, task, entry_date)` — a contributor may log **multiple**
entries against the same task on the same day (two sessions); the grid aggregates them.

**`ActiveTimer(models.Model)` — transient stopwatch state** (`db_table = "timetracking_active_timer"`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUIDField PK | |
| `user` | `OneToOneField(AUTH_USER_MODEL)` | **singleton per user enforced at the DB level** |
| `task` | FK → `projects.Task`, `on_delete=CASCADE` | |
| `started_at` | `DateTimeField` | elapsed is derived, server-authoritative |
| `note` | `CharField(max_length=500, blank=True)` | carried onto the finalized entry |

`ActiveTimer` is **deliberately not a `VersionedModel`.** A live ticking timer is derived
state (elapsed = now − `started_at`), not a logged fact; syncing it as versioned rows
through WatermelonDB would create churn for a value the client recomputes locally. The
`OneToOneField` is a cleaner singleton guarantee than a partial unique on a status flag,
and a stopped timer is *deleted*, not soft-deleted — there is no tombstone to sync. The
**unfinalized-`TimeEntry` alternative is rejected** because a null-`minutes` row would
pollute every aggregate query and the versioned sync stream with in-flight noise.

**Stop = the only finalizer.** `POST /me/timer/stop` reads `started_at`, computes elapsed
seconds, rounds to the nearest minute (floor at 1), creates a `TimeEntry`
(`source=timer`, `entry_date = localdate(started_at)`), and deletes the `ActiveTimer`
row — atomically in one transaction.

**Stale/abandoned timer policy.** A timer left running over a weekend must not log
thousands of minutes. `GET /me/timer/` returns `stale: true` once elapsed exceeds
`TIMETRACKING_TIMER_MAX_MINUTES` (settings, default **600** = 10 h) so the UI can prompt;
`stop` **caps** the logged minutes at that ceiling rather than the raw elapsed. The cap
value is a tunable (🟡, see Blockers).

### 3. `can_log_time` — a dedicated gate, the split ADR-0133 anticipated

ADR-0133 deliberately kept the task capability surface to `can_edit`/`can_delete` for 0.3
and gated time-entry controls off `can_edit`, noting: *"if a future rule lets a non-editor
[act], split it out then — the shared-helper pattern makes that a localized change."* 0.4
is that moment, because the time-log rule **genuinely diverges** from the task-edit rule:

- `can_user_edit_task` restricts a **Member** to **their own assigned** tasks.
- Logging time is recording *where my hours went* — a Member legitimately logs against
  **any task they can access** (a meeting, helping a colleague's task). It is not an edit
  of the task; the entry is owned by the logger.

**Rule:** `can_user_log_time(request, task) = _membership_role(request, task.project_id)
>= Role.MEMBER`. Viewer (0) is denied; Member/Scheduler/Admin/Owner (and Enterprise
custom roles ≥ 100 by the band-threshold contract) may log. The entry's `user` is always
`request.user` (server-set), so this is IDOR-safe by construction.

Mirroring ADR-0133 §1, the predicate is the **single source of truth** for both
enforcement and declaration:

- a new DRF permission class `CanLogTime` (resolves `task → project`, checks the rule) on
  the write endpoints;
- a new read-only `can_log_time: bool` `SerializerMethodField` on `TaskSerializer`
  (calls the same predicate; returns `False` when instantiated without a request, same
  fail-closed contract as `can_edit`). Downstream UI (#1234/#1416/#1435) gates the
  "+ time" affordance off `task.can_log_time`, replacing the 0.3 `can_edit` proxy.

**Edit/delete are author-only by queryset, not by role.** The `/me/time-entries/{id}/`
detail queryset is filtered to `user=request.user`, so PATCH/DELETE on another user's
entry returns **404** (existence-oracle close, matches #996), never 403. Delete is a
`soft_delete()` (VersionedModel tombstone) so the undo window and mobile sync both work.

### 4. Endpoint contract (the part downstream UI streams consume)

Task-nested (the task is the subject) and user-scoped (`/me/`, matching the established
`/me/work/`, `/me/notifications/`, `/me/active-sprints/` convention). All require
`IsAuthenticated`; writes additionally require `CanLogTime` / author-ownership.

**Per-task (caller-scoped):**

```
POST /api/v1/tasks/{task_pk}/time-entries/
  body  { minutes: int(1..1440), entry_date?: "YYYY-MM-DD"=today, note?: str }
  201   { id, task, user, minutes, entry_date, note, source:"manual",
          server_version, created_at }
  perm  CanLogTime (role >= MEMBER on task.project); user is server-set.

GET  /api/v1/tasks/{task_pk}/time-entries/
  200   { results: [<entry>], total_logged_minutes: int }   # caller's OWN entries + own total
  perm  project member (Viewer+ may read their own; they will simply have none).
```

**Detail (author-only):**

```
PATCH  /api/v1/me/time-entries/{id}/   body { minutes?, entry_date?, note? }  → 200 <entry>
DELETE /api/v1/me/time-entries/{id}/   → 204   (soft_delete; powers the undo toast)
  queryset filtered to user=request.user → 404 for anyone else's entry.
```

**Weekly cross-project read (drives the #1435 grid AND the #1234 header rollup):**

```
GET /api/v1/me/time-entries/?from=YYYY-MM-DD&to=YYYY-MM-DD
  200 {
    results: [ { id, task, task_short_id, task_name, project, project_code,
                 project_name, minutes, entry_date, note, source,
                 server_version, created_at } ],          # caller's entries in window, all accessible projects
    totals: {
      by_day:   { "2026-06-29": 525, ... },               # minutes per ISO date (footer row)
      by_cell:  { "<task_id>|2026-06-29": 90, ... },      # (task,date) aggregate (grid cells)
      today_minutes: int,                                  # header "N logged today"
      week_minutes:  int                                   # header "This week · HH:MM"
    }
  }
  N+1-safe: filter(user=request.user, is_deleted=False, entry_date__range=(from,to),
            task__project__memberships__user=request.user,
            task__project__memberships__is_deleted=False)
            .select_related("task", "task__project").
  The membership re-check (defence-in-depth, mirrors /me/work/) drops entries on projects
  the user was removed from.
```

**Running timer (user singleton):**

```
GET  /api/v1/me/timer/
  200 { active: false }
   |  { active: true, id, task, task_short_id, task_name, project,
        started_at, elapsed_seconds, note, stale: bool }   # elapsed/stale server-computed
POST /api/v1/me/timer/start   body { task: <uuid>, note?: str }
  201 { active_timer: <timer>, finalized_entry: <entry>|null }
      # second-start (#1415): if a timer is already running, atomically stop+log it
      #   (finalized_entry = the auto-logged prior timer, for the undo toast) then start B.
POST /api/v1/me/timer/stop
  201 <entry>            # the created TimeEntry (source="timer")
  409 if no active timer (idempotent: a duplicate stop is a no-op 409, not a 500).
```

Display is `h:mm` everywhere; presets map `15m/30m/1h/2h/4h → 15/30/60/120/240`; the grid
parses `2` / `2.5` / `2:30 → minutes` **client-side** before POSTing integer minutes.

### 5. No board broadcast in 0.4

A time entry mutates **no shared board state** — it does not touch the task, sprint,
Kanban column, or Gantt. It is a side-table fact keyed to `(user, task, date)`, visible
only on the logging user's personal surfaces (My Work row chip, header rollup, weekly
grid). Therefore **no `broadcast_board_event()` is emitted** for any time-entry or timer
write. This is consistent with #1415's "personal-only → no board broadcast" note and
ADR-0184's position that realtime board events are a deliberately scoped product line.

- **Single-device freshness** is handled optimistically by the web hooks
  (`useCreateTimeEntry` optimistic + rollback) — no server push needed.
- **Multi-device timer continuity** (start on desktop, resume on mobile) is handled by
  `GET /me/timer/` reconcile-on-load + refetch-on-focus, with `started_at` as the
  authoritative clock — **not** by a broadcast. A true cross-device push would need a
  per-**user** channel group (the board group is per-**project**), which is out of scope
  for 0.4.

**Resolved (accepted):** nothing broadcasts. The `broadcast-check` gate confirmed the
negative — no `broadcast_board_event()` is wired on any time-entry or timer write.

### 6. Offline-sync participation

`TimeEntry` is a `VersionedModel`, so it is sync-eligible. #1258 wires it into the
**pull** delta now; the offline **write/push** queue lands with the mobile track
(#25/#83):

- a `SyncTimeEntrySerializer` in `apps/sync/serializers.py`;
- a `time_entries` change set in `ProjectSyncView` filtered to
  `task__project=project, server_version__gt=since, **user=request.user**` — the
  per-project delta returns only the **caller's own** entries (no cross-user leak through
  sync, the same non-surveillance discipline as the REST surface);
- a watermark receiver in `apps/sync/receivers.py` so a write bumps the project
  high-water mark.

`ActiveTimer` is **not** synced (transient, derived; recovered via `GET /me/timer/`).

### 7. Migration approach

One additive migration in the new app creating `timetracking_time_entry` and
`timetracking_active_timer` — both **new tables**, so there is no NOT-NULL-on-existing-row
hazard. All indexes/constraints are declared in `Meta` (regenerable; survive a
`replaces=` squash), **no `RunSQL`**, no extensions, no ltree. Per migration discipline:
batch the two model definitions, run `makemigrations` **once**, then
`ruff check --fix && ruff format` the generated file. Add `apps.timetracking` to
`INSTALLED_APPS`. The `can_log_time` serializer field is a computed read — **no** task
migration.

## Alternatives Considered

| Decision | Option | Pros | Cons |
|----------|--------|------|------|
| App home | **New `apps/timetracking` (chosen)** | one-app-per-domain; clean home for #1435/#100/EVM growth; OSS↔Enterprise seam at app boundary | one more app in `INSTALLED_APPS` |
| | Extend `apps/projects` | no new app | buries time in a 9k-line module; no domain seam |
| | Extend `apps/resources` | "resources" sounds adjacent | mis-frames it — resources model capacity/skills (Scheduler), not contributor actuals |
| Timer state | **Separate `ActiveTimer`, non-versioned (chosen)** | aggregates/sync never see in-flight rows; OneToOne singleton; deleted-on-stop, no tombstone | a second tiny model |
| | Unfinalized `TimeEntry` (null `minutes`) | one model | null rows pollute every aggregate + the versioned sync stream; partial-unique gymnastics |
| Duration unit | **Integer minutes (chosen)** | no rounding drift; exact totals; presets map cleanly | client formats `h:mm` |
| | Decimal hours | "natural" for timesheets | float drift on sums; the bug the constraint exists to avoid |
| Log gate | **Dedicated `can_log_time` ≥ MEMBER on project (chosen)** | matches "record my hours"; the divergence ADR-0133 named; zero drift via shared predicate | a third capability field |
| | Reuse `can_edit` (Member-own) | no new field | wrong — a Member can't log against an unassigned/colleague task they attended |
| Broadcast | **None (chosen)** | matches no-shared-state reality; no surveillance channel | multi-device timer leans on reconcile-on-load |
| | `board_event` per entry | "live" | broadcasts a personal fact to the whole project group — a privacy/noise regression |

## Consequences

- **Easier:** the four UI issues become pure frontend work against a frozen contract;
  "Can log time" stops being a lie; mobile (#25/#83) inherits a sync-eligible model and
  pull delta; #100 layers approval/EVM onto a clean domain app without a model rewrite.
- **Harder:** a third task capability field (`can_log_time`) must, like `can_edit`,
  degrade to `False` without a request context (nested serialization, tests); the new app
  adds an `INSTALLED_APPS` entry and an OpenAPI schema regen.
- **Deferred (stated, not gaps):**
  - **Cross-contributor task totals** (how much *everyone* logged on a task) are **not**
    exposed in 0.4 — `total_logged_minutes` is the caller's own. An all-contributors
    rollup is a PM/manager view that belongs with #100/Enterprise governance, and
    surfacing it now would create exactly the surveillance surface the `/me/work/`
    discipline forbids.
  - **Edit audit trail** (who changed an entry, when) → #100/Enterprise.
  - **`Submit week`** semantics (#1435) — recommend the cheap **self-submit marker**
    (per-user-per-week `submitted_at`, no approver; entries stay editable) so the button
    has meaning and #100 layers approval on top without a model change. The marker model
    is small enough to land in #1435 against this app; flagged for that issue, not
    decided here.
- **Risks:**
  - *Stale timer* — capped at `TIMETRACKING_TIMER_MAX_MINUTES`; `stale` surfaced so the
    UI prompts rather than silently logging a weekend.
  - *Time-zone of `entry_date`* — server uses `timezone.localdate()` (caller TZ via the
    existing middleware), matching `/me/work`'s "today" bucket; a timer crossing midnight
    dates to `localdate(started_at)`.
  - *Backdating* — manual `entry_date` is rejected if in the future or older than
    `TIMETRACKING_BACKDATE_DAYS` (settings, default 60) so a contributor can fill last
    week but not rewrite arbitrary history.

## Implementation Notes

- **P3M layer:** Operations (OSS).
- **Affected packages:** api (new `apps/timetracking`; `can_user_log_time` +
  `CanLogTime` in `apps/access`; `TaskSerializer.can_log_time`; sync wiring in
  `apps/sync`), web (downstream #1234/#1415/#1416/#1435 — not this issue).
- **Migration required:** yes — one additive migration creating two new tables,
  `Meta`-declared indexes, no `RunSQL`.
- **API changes:** yes — additive. New endpoints (per-task time-entries, `/me/timer/*`,
  `/me/time-entries/`); additive read-only `can_log_time: bool` on the Task response. No
  request-shape change to existing endpoints. Regenerate `docs/api/openapi.json`.
- **OSS or Enterprise:** OSS (`trueppm-suite`). Boundary clean — no `trueppm_enterprise`
  import; `grep -r "trueppm_enterprise" packages/` stays at zero.

### Durable Execution
1. **Broker-down behaviour:** N/A — every write (entry create/update/delete, timer
   start/stop) is a **synchronous** DB transaction with no async side effect. There is no
   `.delay()` to lose, so no outbox row is needed.
2. **Drain task:** N/A — no async category introduced.
3. **Orphan window:** N/A — no `on_commit`-dispatched async work and no broadcast
   (Decision §5), so no in-flight-commit race to filter against.
4. **Service layer:** new `apps/timetracking/services.py` — `log_time(user, task, minutes,
   entry_date, note)`, `start_timer(user, task, note)`, and `stop_timer(user)` (the
   atomic stop+finalize; also the inner call of second-start). No CPM/`enqueue_*`
   interaction — time entries never touch `Task` dates or trigger a schedule recompute.
5. **API response on best-effort dispatch:** N/A — all responses are synchronous
   (`201`/`200`/`204`); nothing returns `{"queued": true}` because nothing is queued.
6. **Outbox cleanup:** N/A — no outbox. Soft-deleted `TimeEntry` tombstones are GC'd by
   the existing VersionedModel sync-tombstone retention (no new purge job).
7. **Idempotency:** entry create honours the existing `IdempotencyMixin` (ADR-0170) via
   `ProjectScopedViewSet`/an `Idempotency-Key`. `timer/start` is guarded by the
   `OneToOneField(user)` (a duplicate start re-enters second-start = stop+restart, never
   two rows). `timer/stop` is naturally idempotent — a second stop finds no `ActiveTimer`
   and returns **409**, never double-logging.
8. **Dead-letter / failure handling:** N/A — synchronous writes surface validation errors
   (`400`) and permission errors (`403`/`404`) inline; there is no task to dead-letter and
   nothing to retry.
