# ADR-0090: Recurring Tasks — TaskRecurrenceRule, Lazy Generator, and CPM Exclusion

## Status
Accepted (2026-05-26)

## Context
PMs need tasks that repeat on a calendar cadence (daily standups, weekly status
reports, monthly steering reviews) without hand-creating each instance. Issue
#312 (epic) splits into a backend foundation (#736, this ADR) and a web UI
(#738).

The load-bearing constraint is **scheduling correctness**: a recurring task is a
*parallel, calendar-driven* activity, not a node in the project's logical
network. Admitting recurring templates or their generated occurrences to the CPM
graph would corrupt float, the critical path, and Monte Carlo P50/P80/P95 inputs
(a 365-occurrence daily standup would swamp the network). Recurring tasks must
therefore never enter the scheduling-engine inputs — and the exclusion must live
at the **engine input boundary**, not merely the API surface, so it cannot be
bypassed by a new caller.

**P3M layer:** Programs and Projects (single project / team). A PM running one
program needs recurring tasks to operate — this is core adoption-tier
functionality, not governance. **OSS / Apache 2.0.**

## Decision

### 1. `TaskRecurrenceRule` model (sync-relevant)
A `VersionedModel` (UUID PK + `server_version` + soft-delete) with a
`OneToOneField` to the **template** `Task` (one rule per task):

- `frequency`: `TaskRecurrenceFrequency` TextChoices — `DAILY | WEEKLY | MONTHLY | CUSTOM`
- `interval`: `PositiveSmallIntegerField(default=1)` — "every N" units (drives `CUSTOM` and >1 multiples)
- `weekdays`: `SmallIntegerField` bitmask (Mon=1 … Sun=64), used by `WEEKLY`
- `day_of_month`: `PositiveSmallIntegerField(null=True)` 1–31, used by `MONTHLY`
- `time_of_day`: `TimeField` + `timezone`: `CharField(default="UTC")`
- End conditions: `end_type` TextChoices `NEVER | ON_DATE | AFTER_N`, plus `end_date` (null) and `end_count` (null)
- Inheritance toggles: `inherit_assignee`, `inherit_subtasks`, `inherit_attachments`, `inherit_morning_notification` (all `BooleanField`)
- Validation enforces the conditional fields (e.g. `end_type=ON_DATE` ⇒ `end_date` required; `WEEKLY` ⇒ at least one weekday bit; `MONTHLY` ⇒ `day_of_month` set).

### 2. CPM-exclusion mechanism — a single denormalized boolean
Add to `Task`:
- `is_recurring: BooleanField(default=False, db_index=True)` — **the load-bearing
  exclusion key.** `True` on the template *and* every generated occurrence.
- `recurrence_rule: ForeignKey(TaskRecurrenceRule, null=True, related_name="occurrences", on_delete=CASCADE)` — set on **occurrences only** (the template is reached via `TaskRecurrenceRule.task`).
- `recurrence_occurrence_date: DateField(null=True, db_index=True)` — the calendar date an occurrence represents; the idempotency key.
- `UniqueConstraint(recurrence_rule, recurrence_occurrence_date)` — Postgres treats NULL `recurrence_rule` as distinct, so normal tasks are unconstrained; occurrences cannot double-create for a date.

Exclusion is then a single `.exclude(is_recurring=True)` / `.filter(is_recurring=False)` applied at **both** direct engine-input boundaries, each with a why-comment:
1. **CPM** — `apps/scheduling/tasks.py::_run_schedule` (`db_project.tasks.all()` → add `.filter(is_recurring=False)`), *and* the `sched_deps` query (drop dependencies whose predecessor or successor is excluded, so the engine never receives a dangling edge).
2. **Monte Carlo / capacity / PDF / Schedule view** — `CommittedTaskManager.get_queryset()` gains `.filter(is_recurring=False)`; all `Task.committed` consumers (ADR-0057) inherit it.

Category-B derived-metric queries (utilization windows, project KPIs, attention
panel, "my tasks") filter on CPM-output fields (`early_start__isnull=False`,
`is_critical=True`, `total_float__lte=…`). Because CPM never runs over recurring
tasks, those fields stay NULL and the recurring rows fall out automatically — no
change required at those sites. This is documented so a future reader does not
"helpfully" add a redundant filter.

A single boolean (vs. deriving exclusion from the relational FKs) is chosen
deliberately: deriving requires *two* conditions at every call site (template via
reverse one-to-one **and** occurrence via FK), and getting one of them wrong is
exactly the silent corruption this feature must avoid. Mirrors the existing
`is_subtask` / `is_milestone` discriminator pattern.

### 3. Attaching/detaching a rule re-triggers CPM
When a rule is attached to an existing task, that task leaves the CPM graph; when
detached/deleted, it rejoins. The viewset defers `enqueue_recalculate(project_id)`
(ADR-0027 outbox) via `transaction.on_commit()` on create/destroy so the critical
path is recomputed without the now-excluded (or newly-included) task.

### 4. Lazy occurrence generator (Beat fan-out)
No `django-celery-beat` is installed, so a single static `CELERY_BEAT_SCHEDULE`
entry runs `projects.generate_recurring_occurrences` hourly. The task:
- Iterates active (`is_deleted=False`, end-condition not yet reached) rules.
- For each, generates only occurrences whose date falls within
  `now + TRUEPPM_RECURRENCE_HORIZON_DAYS` (default 14) that do not already exist —
  a **bounded look-ahead**, never the full (possibly infinite) series.
- Stops at the end condition (`ON_DATE` ⇒ `date ≤ end_date`; `AFTER_N` ⇒
  `occurrences.count() < end_count`).
- Honors inheritance toggles per occurrence. **Materialized in #736:** `assignee`
  (FK copy) and `attachments` (copied `TaskAttachment` rows referencing the **same**
  stored file — no blob duplication). **Persisted but materialization deferred:**
  - `inherit_subtasks` — subtasks are linked to their parent by `wbs_path` (ltree),
    but occurrences are deliberately *not* WBS nodes (`wbs_path=None`, to keep them
    out of summary rollups). Placing inherited subtasks onto a flat occurrence forces
    a WBS-placement decision that belongs with the #738 drawer UX. The toggle is
    stored and validated; materialization lands with #738.
  - `inherit_morning_notification` — no OSS morning-digest infrastructure exists (the
    digest sender is `trueppm-enterprise#112`). The flag is stored so #738 can render
    it and a future notification feature can consume it; it does not send anything yet.
- Generated occurrences are normal tasks otherwise (status `NOT_STARTED`, `wbs_path`
  null, `is_recurring=True`).
- Per-rule work is wrapped in try/except so one malformed rule cannot starve the rest.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Single `is_recurring` boolean (chosen) | One indexed filter at every boundary; impossible to half-apply; matches `is_subtask` precedent | Denormalized (must be set on template + occurrence) |
| Derive exclusion from FKs only | No extra column | Two conditions per call site; silent-corruption risk if one is forgotten — the precise failure mode to avoid |
| Eager full-series materialization | Simple query | Unbounded rows for `NEVER`-ending daily rules; defeats "lazy" requirement |
| `django-celery-beat` per-rule schedules | Native cron per rule | New dependency; DB-backed scheduler operational overhead; fan-out drain matches existing house pattern (drain-queue) |
| Separate `recurrence_engine` Django app | Clean namespace | Recurrence is intrinsic to Task/projects; a new app fragments the model and complicates the OSS sync registration |

## Consequences
- **Easier**: recurring tasks are spawned automatically; CPM/MC stay correct by
  construction; the single boolean makes the invariant auditable (`grep is_recurring`).
- **Harder**: every *future* scheduling-input boundary must remember the exclusion.
  Mitigated by routing Monte Carlo et al. through `Task.committed` (already excluded)
  and a regression test that fails if a template/occurrence reaches CPM.
- **Risks**: (1) a new direct `Task.objects` scheduling caller could bypass the
  filter — covered by the mandatory CPM-exclusion test; (2) clock skew / DST around
  `time_of_day` — generation is date-grained (CPM-irrelevant), so DST affects only
  the future notification, not scheduling; (3) attachment "inheritance" shares the
  stored file across occurrences — deleting one occurrence must not delete the shared
  blob (handled by copying the `TaskAttachment` row, not the file, and relying on
  soft-delete).

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (projects app: model/serializer/viewset/urls/tasks/services; scheduling app: `_run_schedule` filter; sync app: registration; settings: Beat entry)
- Migration required: yes — `projects/0052_*` (new model + 3 Task fields + index + unique constraint). Additive, all nullable/defaulted ⇒ safe.
- API changes: yes — `TaskRecurrenceRule` CRUD nested under the task; rule fields surfaced on the task drawer for #738. Synced model added to the sync delta.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Zero enterprise imports.

### Durable Execution
1. **Broker-down behaviour:** Generation is a periodic Beat task — a missed tick
   self-heals on the next tick (idempotent, horizon-based catch-up); no outbox row
   for generation. The *side-effect* of attaching/detaching a rule (CPM recalc) goes
   through the existing `ScheduleRequest` outbox via `enqueue_recalculate()`.
2. **Drain task:** New Beat task `projects.generate_recurring_occurrences`,
   `@idempotent_task(on_contention="skip")`. Not a reuse — its semantics (generate
   from rules) differ from the outbox drains.
3. **Orphan window:** N/A for generation (it does not consume an `on_commit` outbox;
   it reads committed rule rows). The recalc side-effect reuses the existing
   `ScheduleRequest` drain window (ADR-0027).
4. **Service layer:** Rule attach/detach calls existing
   `scheduling/services.py::enqueue_recalculate()`. Generation logic lives in
   `projects/services.py::_generate_due_occurrences(rule, horizon)` (extracted for
   testability), invoked by the Beat task body.
5. **API response on best-effort dispatch:** N/A — rule CRUD is synchronous DRF
   (201/200 with the rule body). Generation is not request-triggered.
6. **Outbox cleanup:** N/A — generation creates no outbox rows. Occurrences are real
   tasks and are retained (subject to normal soft-delete).
7. **Idempotency:** `UniqueConstraint(recurrence_rule, recurrence_occurrence_date)`
   + `@idempotent_task` Valkey lock. A duplicate run hits the unique constraint
   (caught per-occurrence) and the lock (skip-on-contention) — never double-creates.
8. **Dead-letter / failure handling:** Composes with ADR-0017 retry/time-limits and
   the `FailedTask` dead-letter table. Per-rule try/except logs and continues so one
   bad rule does not fail the whole sweep; a permanently failing task lands in
   `FailedTask` for operator follow-up.
