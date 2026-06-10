# ADR-0114: Seed Schema v2 — Relative-Date Anchors and Event Replay with Backdated History

## Status
Accepted

## Context
ADR-0109 shipped the canonical JSON seed format (`schema_version: "1.0"`) and the
`validate_seed → import_seed → export_program` machinery behind the one-click sample
loader (#375/#617–#620, merged in !517). It materializes **final state**: the importer
writes every row once, with plain ORM saves, inside a single `transaction.atomic()`,
then enqueues one CPM recalc per project.

That makes a freshly imported demo fail three ways the 2026-06-10 product audit (§5)
called the single highest-leverage demo investment for 0.3:

1. **History is a flat line.** Every `django-simple-history` row gets
   `history_date = now()` and `history_user = importer`. A task that imports as
   `COMPLETE` never *was* `IN_PROGRESS`; its History tab reads "one person did
   everything, today." The activity timeline (ADR-0096) is hollow.
2. **Fixed dates rot.** `build_atlas_seed.py` pins `KICKOFF = date(2026, 1, 5)`, so
   Atlas already looks five months stale and ages into a museum piece. The
   programmatic `seed_demo_project` got relative dates right; the JSON path regressed it.
3. **No derived history.** No `SprintBurnSnapshot` rows, so burndown is empty and
   velocity is a single fabricated number, not a trend with a spread.

A focused 5-persona demo-onramp VoC panel scored the proposed fix **6.4/10, no in-scope
blocker** (Alex 8, Priya 8, Sarah 7, Marcus 5, Janet 4). The wins are anchor-relative
dates ("always looks current") and named-actor history with real burndown. The panel
added three requirements, folded into the Decision below:

- 🟡 **Synthetic history must be unambiguously labeled.** A compliance PMO buyer
  (Marcus) must not mistake replayed rows for a production audit trail; a real
  contributor (Priya) must not confuse demo persona attribution with their own records.
- 🟡 **The synthesizer must traverse every column** (incl. `IN_PROGRESS`/blocked), not
  jump `NOT_STARTED → COMPLETE`, or the burndown looks hollow (Alex).
- 🟢 **Scope-injection events should drive the real approve/acknowledge workflow**, and
  the waterfall sample should surface believable baseline-vs-actual critical-path slip.

**P3M layer:** Programs and Projects (OSS). A seed describes a single program and its
projects; nothing aggregates across programs. This is demo/import tooling — pure OSS,
same boundary as ADR-0109. `grep -r trueppm_enterprise packages/` returns only a
docstring cross-reference; the boundary is clean.

### Forces
- Sample files are hand-authored — the schema must stay strict
  (`additionalProperties: false`, JSON-path errors) but now also express a *timeline*.
- Models use UUID PKs and `VersionedModel` (`server_version`, no `created_at`). "Started
  five months ago" is carried by `start_date` (a `DateField`) plus backdated history
  rows — not a `created_at` column, which does not exist.
- `django-simple-history` is registered on Program, Project, Task, Sprint, Dependency,
  Risk (and others). There is **no existing precedent** for writing backdated history
  rows — replay is the first writer.
- CPM output fields are excluded from Task history and CPM `bulk_update` fires no
  `post_save` (ADR-0096/0108). Backdated rows must be written *explicitly*; we cannot
  rely on signals.
- Rollups (parent %-complete, summary schedule dates, scope delta) are computed-on-read
  (ADR-0024/0074/0108) — a seed must never author them.
- Re-import is wipe-then-recreate keyed on `Program.code` (ADR-0092/0109); export is
  byte-deterministic for round-trip (#616). v2 must preserve both.
- **No `TimeEntry`/work-log model exists** anywhere in the codebase.
- **`Risk` lifecycle is `OPEN → MITIGATING → RESOLVED|ACCEPTED|CLOSED`**, and there is
  **no schedule-driving boolean** — Monte Carlo reads `severity = probability × impact`.

## Decision
Introduce **seed schema v2** (`schema_version: "2.0"`) as an *additive superset* of v1,
plus a replay engine in the importer. The validator accepts both majors; v1 fixtures
load unchanged. Atlas migrates to v2 as the proof fixture in the implementation MR; the
other three samples migrate alongside the resource/risk content work (#621/#622).

### 1. Relative-date grammar
A top-level `anchor` key declares the program's reference point, resolved to a concrete
date **at import time** (default: import day). All authored dates/timestamps are offsets:

- Date: `"A-120"` / `"A+15"` → anchor ± N calendar days. Bare ISO dates (`"2026-01-05"`)
  remain legal for v1 compatibility but are discouraged in v2.
- Timestamp: `"A-87T14:10"` → anchor − 87 days at 14:10 (program timezone).
- **Weekend-snap rule:** date offsets that land on a non-working day snap *forward* to
  the next working day, using the project's `Calendar.working_days` bitmask
  (Mon=1…Sun=64) and `CalendarException` ranges, via the existing
  `trueppm_scheduler.is_working_day` (we reuse it, never reimplement). Timestamps are
  **not** snapped (events legitimately occur on the day they occur). Snapping is opt-out
  per field with a `!` suffix (`"A-120!"`) for milestones that must land on an exact date.

`validate_seed` resolves and range-checks offsets (no event may post after the anchor /
"today"; `from`/`to` of a transition must be valid choice values).

### 2. The `events` section
A new top-level ordered array. Each event:

```jsonc
{ "at": "A-87T14:10", "actor": "alex", "action": "task.status",
  "target": "task:atlas-api-auth", "from": "IN_PROGRESS", "to": "REVIEW" }
```

Action taxonomy (v2.0), each mapping to one real write path:

| `action` | Effect on replay |
|---|---|
| `task.status` | set status + `status_changed_at`; write backdated Task history row |
| `task.assign` | set `assignee`; backdated history row |
| `task.estimate` | set three-point sub-object (all-or-none, `estimate_status=accepted`, ADR-0093) |
| `task.points` | set `story_points` / `remaining_points` |
| `task.comment` | create `TaskComment` with backdated `created_at` |
| `task.ac_met` | set DoR/acceptance state |
| `sprint.activate` | `state=ACTIVE`, snapshot `committed_*`, `activated_at` |
| `sprint.close` | `state=COMPLETED`, snapshot `completed_*`, `closed_at`, `goal_outcome` |
| `sprint.scope_inject` | call `record_sprint_scope_change(...)` → real `SprintScopeChange` audit row (PENDING) |
| `sprint.scope_resolve` | call `accept_scope_change` / `reject_scope_change` |
| `baseline.capture` | snapshot a `Baseline` + `BaselineTask` rows at that day's dates |
| `risk.status` | transition Risk status (OPEN/MITIGATING/RESOLVED/ACCEPTED/CLOSED); backdated history row |
| `retro.action` / `retro.promote` | create RetroActionItem and (optionally) promote to a backlog task |

Events are **append-only and ordered by `at`** (ties broken by array index). `actor` is a
slug into the seed's `accounts`/persona cast (§5). Idempotency on re-import is inherited
from wipe-then-recreate — the whole program subtree is deleted and the timeline is
replayed from scratch, so events need no individual identity. **`time.log` is explicitly
out of scope for v2.0** — no time-entry model exists yet; it is owned by #926
(fast contributor time-entry) and depended on by #754 (cost/EVM). See Consequences.

### 3. Replay with backdating
After Pass A/B build final-state rows (so all FKs resolve), a **third pass** walks
`events` chronologically and, per event, mutates the target and writes a history row
dated to `event.at`:

- Set `instance._history_date = event_dt` and `instance._history_user = actor_user`
  before `instance.save()`. simple-history honors both. (First use of this in the repo.)
- `auto_now_add` fields (`TaskComment.created_at`, `Sprint.created_at`, etc.) are set by
  writing the field explicitly and passing `update_fields`, or via `bulk_create` then a
  follow-up `update`, since `auto_now_add` only fires on the first insert.
- A **sim clock** advances day-by-day across the event span. At each day boundary, for
  every `ACTIVE` sprint, replay calls
  `upsert_burndown_for_sprint(sprint, snapshot_date=that_day)` so each
  `SprintBurnSnapshot` reflects the task states *as of that day* (we have replayed all
  events up to it). This yields a real burndown curve and, across closed sprints, a
  velocity trend with a spread.
- Backdated `ForecastSnapshot` / `MonteCarloRun` rows (ADR-0106 / 0109-MC) may be emitted
  by `baseline.capture` and `sprint.close` to show historical forecast drift, respecting
  the velocity-privacy band. (Optional; Atlas only.)

### 4. Deterministic synthesizer
Hand-authoring every status move for ~150 tasks is infeasible. A synthesizer fills the
gaps: for any task whose final state implies it passed through earlier columns but whose
events don't spell them out, it generates the missing `task.status` (and a plausible
assign/comment) events. It walks **backward from the final column through the full
canonical sequence** — `COMPLETE → REVIEW → IN_PROGRESS → NOT_STARTED` (and through
`ON_HOLD`/blocked where the narrative calls for it) — never skipping `IN_PROGRESS`, so
burndowns are not hollow (VoC/Alex). Authored events always override synthesis.
Determinism comes from a `random.Random(seed)` seeded from a stable source
(`f"{program.code}:{task.code}"`), so re-import and round-trip are reproducible — no
wall-clock or unseeded randomness.

### 5. Actor policy and synthetic-data labeling
- **UI import path:** `create_users=False`. Personas resolve to **namespaced,
  unusable-password User rows** (the `<sample>-<slug>` accounts #517 already creates),
  never to a real pre-existing account. `history_user` FKs to these rows — real
  attribution, zero login capability. This must go through the #1004/#1057 resolver so a
  persona slug can never bind to a real user.
- **CLI path:** `--with-personas` creates real dev logins (known password) flagged for an
  operator to delete, as today.
- **Labeling (VoC 🟡):** every replayed row belongs to a `Project`/`Program` already
  flagged `is_sample=True`. The history/activity API annotates rows on sample programs
  with `synthetic: true`, and persona display names are rendered visually distinct in the
  web client (#1053 owns the surface). This keeps a fabricated audit trail from reading
  as a real one and keeps demo attribution from bleeding into a real user's feed.

### 6. Side-effect suppression and single recalc
Replay introduces a `seed_replay` context manager backed by a `contextvars.ContextVar`.
While active:

- `broadcast_board_event`, `dispatch_webhooks`, and `_notify_event` short-circuit to
  no-ops (a real workspace must not be spammed by a demo load — Priya 🔴-adjacent).
- The real-time `task_status_changed → upsert_burndown_for_sprint` receiver skips its
  *today-dated* write; replay drives backdated burndown explicitly instead.

After the transaction commits, replay enqueues exactly **one** CPM recalc per project via
`scheduling/services.py::enqueue_recalculate(project_id)` (never `.delay()` directly,
ADR-0027). To give #1053 a signal that CPM is still pending, Project gains
`recalculated_at = DateTimeField(null=True)`; the importer leaves it null on import, and
the `recalculate_schedule` task stamps it on success. The web Schedule view shows the
existing `RecalculatingBadge` while `recalculated_at` is null/older than the import.

### 7. Exporter (event-timeline export deferred)
The exporter keeps emitting **v1** (final-state, `schema_version: "1.0"`) for now, so the
existing byte-identical round-trip guarantee (#616) is preserved unchanged and a live
program still exports cleanly to share/edit. **Reconstructing the full `events` timeline
from `*.history` + burn snapshots + scope-change rows is deferred to a follow-up** — it is
a large, round-trip-determinism-sensitive change whose value is the import/edit workflow,
not the demo on-ramp (which is entirely the import path). A v2 sample therefore exports as
a v1 final-state document; re-importing it materializes final state without replay. The
`events`-export AC of #1074 is explicitly carried to the follow-up (**#1109**, which also
covers `retro.*` replay) rather than rushed.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Schema v2 + event replay (chosen)** | Demo tells a life; real burndown/velocity/history; round-trips; reuses CPM/scope/burn services | First backdated-history writer; replay pass adds importer complexity; synthesizer needs care |
| B. Keep v1, fabricate history rows in `build_*.py` scripts only | No importer change | Scripts diverge from runtime; export can't round-trip; no sim-clock burndown; brittle |
| C. New `Activity`/event-log model instead of backdating simple-history | Clean separation of synthetic vs real | Duplicates the history surface (ADR-0096), two timelines to reconcile, larger blast radius |
| D. Add a real `TimeEntry` model so `time.log` events replay | Completes the taxonomy | Net-new feature far beyond demo data; already owned by #926/#754 — scope creep |
| E. Relative dates only (no events) | Small; fixes the "stale" problem | Leaves the hollow-history and empty-burndown problems — the audit's main points |

## Consequences
- **Easier:** a one-click demo reads as a program that has run for months — dated
  transitions by named people, real burndown curves, multi-sprint velocity with a spread,
  scope-injection audit, baseline-vs-actual slip. Export round-trips the timeline.
- **Harder:** the importer gains a replay pass, a sim clock, a synthesizer, and a
  suppression context manager. Backdating history is new surface that needs its own tests.
- **Risks:**
  - *Backdating correctness* — `auto_now_add` and `status_changed_at` must be set
    explicitly; a missed field silently re-stamps to today. Mitigated by a CI smoke test
    asserting history-row date spreads and counts (issue AC).
  - *Suppression scope* — too broad and backdated burndown is skipped too; too narrow and
    a real broadcast leaks. Mitigated by surgical receiver checks + a test that asserts no
    broadcast/webhook/notification fires during replay.
  - *`time.log` gap* — `time.log` is dropped from v2.0; the time-entry model it needs is
    owned by #926 (and consumed by #754 cost/EVM). When #926 lands, a `time.log` action can
    be added to the taxonomy and Atlas re-seeded with time history. Documented here so the
    omission is a decision, not an oversight.
  - *Migration collision* — the new `Project.recalculated_at` lands at `projects/0067`;
    unmerged #1092 also claims 0067. Renumber whichever merges second (known repo pattern).
  - *Risk taxonomy* — the issue's "identified/analyzed/mitigated/realized" lifecycle does
    not match the real `OPEN/MITIGATING/RESOLVED/ACCEPTED/CLOSED` enum; v2 uses the real
    enum. "Schedule-driving" risks are expressed via high `probability × impact` + task
    linkage (what Monte Carlo actually reads), not a new flag.

## Implementation Notes
- **P3M layer:** Programs and Projects (OSS).
- **Affected packages:** `api` (seed/{validation,importer,exporter}.py, schema v2 file,
  receivers suppression, Project migration, build_*.py scripts), `web` (#1053 surfaces),
  `scheduler` (read-only reuse of `is_working_day`). No mobile change.
- **Migration required:** yes — `Project.recalculated_at` (`projects/0067`, nullable, no
  backfill needed). simple-history table gets the mirrored column automatically.
- **API changes:** additive — history/activity serializers gain a `synthetic` flag on
  sample programs; no new endpoints. Import endpoint contract unchanged (still synchronous
  201 with the program payload).
- **OSS or Enterprise:** OSS (`trueppm-suite`).

### Durable Execution
Replay runs **synchronously inside the importer's existing single `transaction.atomic()`**
(inherited from ADR-0109) — it is materialization, not a background job.

1. **Broker-down behaviour:** the import/replay commit succeeds regardless of broker
   state. The only async effects are the post-commit per-project `enqueue_recalculate`
   (best-effort `.delay()` backed by the `ScheduleRequest` outbox + 30s drain, ADR-0027)
   and — *suppressed during replay* — board broadcasts. If the broker is down the
   `ScheduleRequest` rows stay PENDING and `drain_schedule_queue` dispatches them; clients
   reconcile schedule state on reconnect.
2. **Drain task:** none new. Reuses `drain_schedule_queue` for the post-import recalc.
3. **Orphan window:** N/A — replay creates no outbox rows of its own; the recalc uses the
   existing `ScheduleRequest` flow and its established window.
4. **Service layer:** the `seed/` subpackage (`importer.py` gains a `_replay(events)`
   pass + `seed_replay()` context manager). CPM dispatch goes through
   `scheduling/services.py::enqueue_recalculate`, never `recalculate_schedule.delay`.
5. **API response on best-effort dispatch:** unchanged — import returns **201** with the
   created program synchronously (transactional), not a `{"queued": true}` 202. CPM
   completion is observable via the new `recalculated_at` field + the existing
   `/projects/{pk}/task-runs/` indicator.
6. **Outbox cleanup:** N/A — no new outbox rows. The reused `ScheduleRequest` rows follow
   their existing purge.
7. **Idempotency:** re-import is wipe-then-recreate on `(workspace, Program.code)`
   (ADR-0092); the timeline is replayed from scratch each time, so events carry no
   identity. The synthesizer is deterministic (`Random("{program.code}:{task.code}")`), so
   repeated imports and round-trips produce identical history. `recalculated_at` is set by
   the idempotent `recalculate_schedule` task (safe to run twice).
8. **Dead-letter / failure handling:** any replay error rolls back the whole
   `transaction.atomic()` — a partially-replayed program never persists.
   `validate_seed` raises `SeedValidationError` with the offending JSON path → 400.
   There is no retry queue because replay has no async step; a failed post-commit recalc
   is recovered by the existing `ScheduleRequest` drain.
