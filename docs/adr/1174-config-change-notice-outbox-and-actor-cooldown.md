# ADR-1174: Config-Change Notices Leave the Request Through an Outbox, and a Repeat From the Same Actor Collapses

## Status

Accepted (2026-09-13)

> **Implementation status (2026-09-13):** ships with this ADR — the `ConfigNoticeRequest`
> outbox model (`packages/api/src/trueppm_api/apps/projects/models.py`), the enqueue and
> cooldown in `packages/api/src/trueppm_api/apps/projects/config_notice.py`, and the
> `projects.emit_config_notice` / `projects.drain_config_notice_requests` /
> `projects.purge_old_config_notice_requests` tasks in
> `packages/api/src/trueppm_api/apps/projects/tasks.py`.

## Context

**P3M layer:** Programs and Projects (OSS). One project's (or one program's projects')
surface configuration and the notices sent to that project's own members. Nothing
aggregates across programs.

!2050 (#2972) made a change that moves or hides work — a removed board lane, a hidden
column, a hidden leaf view, a switched methodology preset — send each affected member an
inbox notice naming what happened to *their* items. Two findings from that MR's gates
were accepted with mitigations and recorded as #3009:

1. **The fan-out runs in the request thread** (perf-check, HIGH). Every emit is a
   `transaction.on_commit` callback, and `on_commit` fires synchronously in the web worker
   after COMMIT, not on Celery. The program settings matrix
   (`ProgramViewSet.bulk_project_fields`) applies one field map to up to
   `MAX_BULK_TARGETS = 200` projects; #3335 batched the reads to ~9 queries per 50-project
   chunk, but the resolution, rendering and inserts still hold the HTTP response. The only
   containment is that the endpoint is program-admin-only and capped.
2. **Nothing dedupes a repeatable fan-out** (security-review, MEDIUM). Hide a column,
   un-hide it, hide it again: each hide notifies everyone again.

#3009 is also the declared blocker for #3292, which adds a *workspace*-scope trigger —
one with no 200 cap, reaching every project in the install. That trigger must not ship
against the synchronous path.

**Why the obvious fixes were not applied in !2050, and remain wrong:**

- *"Just `.delay()` it."* A bare `.delay()` from `on_commit` trades a slow request for a
  fan-out that can be lost without trace when the broker is unreachable at that instant.
  A notice nobody receives is indistinguishable from a change nobody made — worse than a
  slow response. The codebase's rule (`docs/durability/on-commit-audit.md`, the
  "durability-hole" bucket) is outbox row first.
- *"Dedupe on (project, event type)."* That also suppresses a genuinely different second
  change. A team told about the first lane removal and not the second is worse off than a
  team told twice about one: a missing notice is silent, a duplicate is merely annoying.

## Decision

### A. A dedicated single-shot outbox, not the workflow engine

Per ADR-0080 §D and `docs/durability/workflow-vs-outbox.md`, reliably running **one** task
after a commit is the outbox's job; the workflow engine is for multi-step orchestration.
The emit is one fire-and-forget task, so it gets its own outbox table, mirroring
`ScheduleRequest` and `SprintCloseRequest`.

**`ConfigNoticeRequest`** (`apps/projects`), one row per notify call:

| Field | Purpose |
|---|---|
| `kind` | `board` or `surface` — selects the renderer |
| `payload` | JSON: everything the emit needs, resolved at enqueue time (project id(s), before/after snapshots or removed lanes / hidden columns, actor id, actor display name) |
| `status` | `pending → dispatched → running → done`, or `dead` |
| `attempt_count` | incremented on each claim |
| `celery_task_id`, `requested_at`, `claimed_at`, `completed_at` | forensics and the drain's windows |

No project FK: one surface row carries up to 200 projects, and a row must survive its
project being deleted before the drain runs (the emit then simply finds no recipients).

### B. Enqueue is inside the write's transaction; dispatch is best-effort after commit

`notify_board_config_change` and `notify_surface_changes` keep their signatures. Instead
of registering an `on_commit` emit, each **inserts the outbox row in the caller's
transaction** — atomic with the config write, so a rolled-back write leaves no row and a
committed one always does — then registers an `on_commit` callback that calls
`emit_config_notice.delay(row_id)` and marks the row `dispatched`. A broker failure there
is logged and swallowed; the row stays `pending` for the drain.

The request thread's added cost is one INSERT. Every read and render moves to the worker.

### C. The worker claims the row before doing anything

`emit_config_notice(request_id)` flips the row to `running` with a conditional UPDATE
(`status IN (pending, dispatched)`). Zero rows updated means another delivery already
claimed it or it is terminal: no-op. This is what makes the on-commit dispatch and a
drain re-dispatch of the same row safe to race. The emit itself is the existing
`_emit_board_notifications` / `_emit_surface_notifications`, unchanged — including its
per-chunk and per-project failure isolation — so the rendered notices are byte-identical
to what the request thread wrote before.

### D. An actor-keyed cooldown that only collapses a repeat of the *latest* notice

Before emitting for a project, the worker compares this notice's **signature** against the
last notice actually sent for that `(project, kind)`, held in Valkey with a TTL of
`TRUEPPM_CONFIG_NOTICE_COOLDOWN_SECONDS` (default 600; `0` disables). It **suppresses only
when all three match**: same actor, same signature, and a different outbox row.

- **Signature** is the content the notice asserts: for the board, the removed lanes'
  `(status, key)` pairs and the hidden columns' statuses; for the surface, the new preset
  (if it changed) and the surfaces hidden and shown.
- **Why the comparison is against the *last sent* notice, not "any recent" one.** Consider
  a preset flip-flop: Agile→Waterfall (sent), Waterfall→Agile (sent), Agile→Waterfall.
  Suppressing the third because the first matched would leave the recipient's most recent
  notice saying "now Agile" while the project runs as Waterfall — the suppression would
  turn a duplicate into a false statement. Against the last-sent signature (Agile) the
  third differs, so it sends. The hide/un-hide/hide cycle the issue names *does* collapse:
  an un-hide notifies nobody, so the last notice sent still says "Review hidden", which is
  exactly the state again.
- **Why the key is per project, not per actor.** If Dana switches to Waterfall, Sam
  switches to Agile, then Dana switches to Waterfall again, a per-actor key would find
  Dana's own matching signature and suppress — leaving Sam's "now Agile" as the latest
  word. Keying on the project and requiring the stored actor to match sends it.
- **Why the stored value carries the row id.** A worker that dies mid-emit is re-driven by
  the drain. Without the row id, the retry would find its own signature and suppress
  itself, losing every chunk not yet written.
- **Fail-open.** A Valkey error sends the notice, matching `MentionRateThrottle`. The
  cooldown only ever removes noise; it must never become a way a notice is lost.
- **No actor, no cooldown.** A change with no authenticated actor has nothing to key on,
  and system writes are not the repeatable human cycle this addresses.

### E. Drain, recovery, retention

- **`projects.drain_config_notice_requests`**, Beat every 30 s,
  `@idempotent_task(on_contention="skip")`:
  - rows `dispatched`/`running` whose `claimed_at` is older than 10 minutes are recovered
    to `pending`, or marked `dead` (logged at ERROR) once `attempt_count` reaches 3;
  - `pending` rows older than the 5-minute orphan window are dispatched, at most 100 per
    tick.
- **`projects.purge_old_config_notice_requests`**, nightly 02:55 UTC: deletes `done`/`dead`
  rows older than 7 days. Standalone, like `scheduling.purge_old_schedule_requests`: this
  is internal transport plumbing, not an operator-tunable retention row in the ADR-0173
  coordinator.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Dedicated outbox table + worker + drain** (chosen) | Atomic with the write; survives a broker outage; request pays one INSERT; mirrors three existing outboxes | One more table and two Beat entries |
| Bare `.delay()` from `on_commit` | Smallest diff | The durability hole the codebase's audit forbids — a broker blip loses the notice silently |
| Workflow engine (`start_workflow`) | Durable, generic | ADR-0080 §D and the workflow-vs-outbox guide reserve it for multi-step orchestration; ceremony for one task |
| One outbox row per project | Per-project status | 200 rows and 200 dispatches per bulk apply; loses #3335's batched reads, which are what make the emit cheap |
| Dedupe on `(project, event_type)` | Simple | Suppresses a genuinely different second change; a missing notice is silent |
| Cooldown on "any matching notice in the window" | Simple | Suppresses a repeat after an intervening *different* notice, leaving the latest notice describing a state that no longer holds |
| Cooldown checked in the request, before the row is written | No row for a suppressed notice | A rolled-back transaction still sets the key, suppressing the next genuine change; adds a Valkey round-trip to the hot PATCH path |
| Wrap the whole emit and the `done` mark in one transaction (exactly-once) | A crash mid-emit leaves nothing | A failed chunk insert aborts the transaction, so later chunks fail too — breaks the per-chunk isolation #3335 pinned; savepoints per chunk add queries to the pinned query budget |

## Consequences

- **Easier:** the bulk matrix responds in the time its writes take; #3292's workspace-scope
  trigger has a durable, off-request path to ride on; a column toggled back and forth no
  longer re-notifies the whole team.
- **Harder:** notices now arrive seconds after the change (one broker hop) rather than in
  the same response cycle. Tests that assert on the inbox must run the worker inline.
- **Risks:**
  - *At-least-once, not exactly-once.* A worker killed after some chunks were written and
    before `done` is re-driven, and the re-run re-inserts those chunks. Accepted: the
    duplication is bounded to one re-run of rows already delivered, and the alternative
    that prevents it breaks chunk isolation (see Alternatives). A duplicate is annoying; a
    lost notice is silent.
  - *A suppressed notice is invisible to its would-be recipients by design.* Each
    suppression is logged at INFO with the project, actor and signature, so "why was
    nobody told the second time" has an answer in the logs.
  - *Beat down.* A row whose on-commit dispatch failed waits for the drain; if Beat is also
    down, notices wait with it. ADR-0081's `/health/beat/` covers detection.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `api` (model, migration, `config_notice.py`, `tasks.py`, Beat
  schedule, one setting); `docs` (`docs/durability/on-commit-audit.md` machinery table;
  `features/notifications.md` gains the cooldown and the arrival delay)
- Migration required: **yes** — new `projects_confignoticerequest` table (empty on create,
  no constraint on existing rows)
- API changes: **no** — no endpoint, serializer, or response shape changes; the three
  write endpoints still return what they returned
- OSS or Enterprise: **OSS** — a per-project team notification on an existing OSS surface

### Durable Execution

1. Broker-down behaviour: outbox pattern. The row is written in the write's own
   transaction; the on-commit `.delay()` is best-effort and a failure leaves the row
   `pending`.
2. Drain task: new `projects.drain_config_notice_requests`, every 30 s,
   `@idempotent_task(on_contention="skip")`. No existing drain matches — the row schema
   and the consumer (a notice emit) differ from every other outbox.
3. Orphan window: 5 minutes for `pending` rows; 10 minutes on `claimed_at` for
   `dispatched`/`running` recovery (the emit's soft time limit is 120 s).
4. Service layer: `config_notice.notify_board_config_change` and
   `config_notice.notify_surface_changes` — unchanged signatures, now enqueue functions.
5. API response on best-effort dispatch: N/A — the notice is a side effect of a write
   whose own response is unchanged; no caller receives a task id.
6. Outbox cleanup: `projects.purge_old_config_notice_requests` nightly at 02:55 UTC, 7-day
   retention on `done`/`dead` rows.
7. Idempotency: the outbox row PK. The worker claims with a conditional UPDATE and no-ops
   on a row another delivery claimed or already finished; the cooldown's stored row id
   keeps a re-driven row from suppressing itself.
8. Dead-letter / failure handling: the emit logs and swallows per-chunk and per-project
   failures, as before. An exception escaping the emit returns the row to `pending` for the
   drain; recovery marks it `dead` at 3 attempts and logs at ERROR. A dead row is not
   re-triggerable — the next config change sends a fresh notice.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1174` — **0** issues (a new
      number; #3009 and #3292 predate it and name no ADR).
- [x] Issues carrying pre-ADR scope rewritten: **0**. #3009's body already proposes this
      shape (outbox-then-worker; an actor-keyed throttle that never suppresses a different
      change). §D narrows its wording — "collapse repeated notices from the same actor
      within a window" — to "collapse a repeat of the latest notice sent", for the
      flip-flop reason given there.
