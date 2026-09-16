# ADR-1175: Sample Date Re-Anchoring Is a Manual Owner Action Over a Three-Tier Field Rule

## Status
Accepted (2026-09-15)

## Context

ADR-0114 fixed *"fixed dates rot"* by making the seed format author every date as an
offset from an `anchor` resolved at **import day** (`seed/reldates.py::resolve_anchor`,
called once at `seed/importer.py:325`). A freshly loaded demo therefore always looks
current.

It ages from there, and nothing moves it. The 2026-09-06 UX audit (H10, #3481) observed a
seven-week-old Atlas sample rendering an "Active" sprint that "Completed Jul 20" with
"Day 14 of 14 · 0 days left", nine overdue tasks per project, a Critical program health,
and a burndown ending six weeks before today — while the banner still promises "60 days of
history … render out of the box". An evaluator who installs on Monday and demos the
following Friday is demoing an overdue program.

This ADR settles the two decisions the issue left open: **what re-anchors the sample**,
and **what "shift" means for each class of dated column**. It does not revisit ADR-0114's
relative-date grammar, which is the machinery this reuses.

**P3M layer:** Programs and Projects (OSS). One sample is one program; nothing aggregates
across programs. Demo/import tooling, same boundary as ADR-0109 and ADR-0114.
`grep -r trueppm_enterprise packages/` returns only docstring cross-references — the
boundary is clean, and sample data is unambiguously OSS, so `enterprise-check` is n/a.

### Forces

- **F1** Re-anchoring is re-running a resolution that already exists, not a new concept.
- **F2** `try.trueppm.com` is **read-only by construction** — `load_sample_project` runs
  without `--with-personas` and without `create_admin`, so there are zero login-capable
  accounts (guarded by `scripts/check-demo-readonly.sh` and
  `tests/apps/projects/test_demo_readonly_posture.py`, ADR-0658). A banner button is
  structurally unclickable there.
- **F3** The hosted demo re-seeds only via the Helm post-install/post-upgrade hook Job
  (`packages/helm/templates/demo-seed-job.yaml`). Its staleness window is the release
  cadence, not a day.
- **F4** `load_sample` is destructively idempotent, and `_replace_existing` refuses any
  program holding a non-sample project (#2476).
- **F5** The loader's dated surface is ~20 models and ~50 date columns, plus
  `django-simple-history` `history_date` on every historied model.
- **F6** `scheduling/services.py::enqueue_recalculate()` is the existing transactional
  outbox entry point for CPM recalculation, drained every 30 s by
  `drain-schedule-queue`.

A simulated VoC panel (personas, **not** user research — its findings are recorded here
on their own merits and are not customer feedback) raised two constraints that changed
this design: a manual-only fix does not reach the hosted demo, and a nightly background
rewriter that every self-hosted install acquires is the self-hosting operator's
documented pain — *"background jobs fail silently; I find out when a user reports stale
data a week later"*. Both are answered in Decision 1.

## Decision

### Decision 1 — A manual owner action ships. No Celery beat.

`POST /api/v1/programs/{id}/shift-sample-dates/` is the shipped mechanism, surfaced as
**"Shift dates to today"** in the sample banner. **No entry is added to
`CELERY_BEAT_SCHEDULE`.**

The shift logic lands in `apps/projects/seed/reanchor.py::shift_sample_dates(program)` —
a service function — and is additionally exposed as a management command
(`python manage.py shift_sample_dates`). That command is the unit a demo *deployment*
can schedule as a Kubernetes CronJob it owns, exactly as `demo-seed-job.yaml` owns its
Job today, without every self-hosted install acquiring a background rewriter it never
asked for.

Rejecting the global beat is the operator constraint taken seriously: a nightly job
silently rewriting ~50 date columns across 20 models on any install that happens to hold
a sample program trades a visible staleness bug for an invisible-write one, and the
blast radius makes a silent failure expensive. Opt-in through a documented Helm value is
the shape the operator's own criteria ask for; a hidden beat is not.

**Deliberately deferred, with justification:** the Helm CronJob that would close the
hosted-demo gap (F2/F3) is **not built here**. It is a deployment-surface change needing
`values.yaml` documentation and a sizing note, and the management command is the only
part of it that is application code. The hosted demo's staleness window remains the
release cadence until it lands. This is a conscious scope call, not an oversight — the
issue's acceptance criteria concern the banner and the offset coverage, neither of which
depends on it.

### Decision 2 — The anchor lives on `Program`; three tiers govern the columns.

`Program.sample_anchor_date` (`DateField(null=True, blank=True)`, migration
`0153_program_sample_anchor_date`) records the anchor the importer resolved. NULL on
every non-sample program, and NULL is the honest "this predates the field" state for
samples loaded before this ships — the endpoint refuses rather than guessing.

The delta is **always** `timezone.localdate() - program.sample_anchor_date`, computed
server-side. **The endpoint accepts no request body.** There is no caller-supplied target
date, so there is no unbounded offset to validate, no replay, and no overflow. After a
successful shift `sample_anchor_date` is set to today, which makes a second click compute
a delta of zero and no-op — the action is idempotent by construction rather than by
guard.

Every dated column the loader writes falls into exactly one tier.

**Tier 1 — OFFSET by the delta.** The authored plan and its synthesized history:

| Model | Columns |
|---|---|
| `Project` | `start_date`, `status_date`, `status_date_floor_armed_at`, `draft_started_at` |
| `Task` | `planned_start`, `actual_start`, `actual_finish`, `blocked_since`, `status_changed_at`, `seeded_at`, `edited_at`, `recurrence_occurrence_date` |
| `Sprint` | `start_date`, `finish_date`, `activated_at`, `closed_at`, `milestone_bound_at` |
| `Baseline` / `BaselineTask` | `created_at`; `start`, `finish`, `actual_start`, `actual_finish` |
| `CalendarException` | `exc_start`, `exc_end` |
| `Program` | `target_date` |
| `AcceptanceCriterion`, `BacklogItem`, `Risk`, `Dependency` | `met_at`, `pulled_at`, `mitigation_due_date`, `accepted_at` |
| `TaskComment`, `TaskNote`, `TaskLabel`, `TaskAttachment`, `CommentReaction`, `CommentAcknowledgement`, `RiskComment`, `RetroActionItem`, `SprintRetro`, `SprintScopeChange` | `created_at`, `edited_at`, `added_at`, `updated_at` |
| `TimeEntry`, `TimesheetSubmission` | `entry_date`; `week_start`, `submitted_at` |
| `MonteCarloRun` | `taken_at`, `status_date`, `cpm_finish`, `p50`, `p80`, `p95` |
| `ProjectForecastSnapshot` | `captured_at`, `cpm_finish`, `mc_p50_finish`, `mc_p80_finish`, `mc_p95_finish` |
| every historied model | `HistoricalXxx.history_date` |

Three of these need their reasoning stated, because the naive answer is the opposite one.

*Baselines are offset, not frozen.* A baseline is a frozen **plan**, and
baseline-vs-actual variance is a **relative** quantity. Moving both sides by the same
delta preserves every variance exactly. Leaving baselines pinned while the plan moves
would manufacture a fabricated 47-day slip on every task in the sample — precisely the
"demo shows an overdue program" defect this ADR exists to remove.

*History is offset.* ADR-0114's entire contribution was **backdated** synthesized history;
leaving `history_date` pinned while the plan moves would place a task's "went
IN_PROGRESS" event weeks before its own planned start. These rows are synthesized demo
content, labeled as such per ADR-0114 §5 — not an audit trail, and offsetting them
falsifies nothing that was ever a record of a real act.

*Forecast history is offset.* `MonteCarloRun` and `ProjectForecastSnapshot` rows in a
sample were synthesized by `seed/forecast_backfill.py`, never produced by a real engine
run. Offsetting the capture timestamp and the percentile dates by one delta preserves the
trend's shape exactly, which is what the trend chart renders and what the banner promises.

**Tier 2 — RECOMPUTE, never offset.** CPM engine output:
`Task.early_start`, `early_finish`, `late_start`, `late_finish`, `scheduled_start`,
`total_float`, `free_float`, `is_critical`.

These are derived, not authored — which is why `_HISTORY_EXCLUDED_TASK` already excludes
them, and why ADR-1152 clears rather than migrates them. `early_start`/`early_finish` are
the **remaining-work** window (ADR-0752), not the planned span, and utilization reads
them; offsetting them would silently change computed load and forecast. The shift
therefore moves the **inputs** and then calls
`enqueue_recalculate(project_id, reason=MANUAL)` once per project, setting
`Project.recalculated_at = None` so the Schedule view shows its existing "recalculating"
badge (#1053) instead of reading as broken.

**Tier 3 — LEAVE UNTOUCHED, deliberately:**

- `Task.wbs_path` — the only parenthood in the system, with no integrity enforcement.
  The shift touches **date columns only** and never structure.
- Every `deleted_at` / soft-delete tombstone (`Task`, `Project`, `TaskComment`,
  `TaskNote`, `TaskAttachment`, `TaskRelation`, `Dependency`). `deleted_at` participates
  in the partial unique index `unique_task_wbs_path_per_project_live` (migration 0148);
  rewriting it risks a constraint violation for no demo benefit.
- `Project.archived_at`, `Program.closed_at` — lifecycle facts, not plan.
- `ProgramMembership` / `ProjectMembership` / `TeamMembership` join dates — "joined seven
  weeks ago" is both true and invisible on every surface the staleness shows.
- `Notification`, `Mention` — per-user read-state ephemera, not plan.
- `Project.recalculated_at` — nulled by Tier 2, not offset.

The coverage obligation in the issue's acceptance criteria is met against **all three
tiers**: the pytest suite asserts the offset where an offset is specified *and* asserts
non-mutation where Tier 3 applies, so a future contributor who widens the sweep
accidentally breaks a test rather than a constraint.

### Authorization

`shift_sample_dates` gets its own branch in `ProgramViewSet._rbac_permissions` returning
`[IsAuthenticated(), IsProgramOwner(), IsProgramNotClosed()]` — the `remove_sample`
precedent — and is **not** added to `_CLOSE_BYPASS_ACTIONS`: re-anchoring a closed
program's dates is meaningless, so the NotClosed gate binds here where it is bypassed for
teardown. `mcp_token_guards()` is appended by `get_permissions` as it is for every action,
which is what keeps an `mcp:read` token off a durable bulk write (ADR-0112: OSS agents
ship read + `schedule:simulate` only).

`IsOrgAdmin` / `IsOrgScheduler` are **not** used: they are self-grantable via project
create (#3569) and are effectively "any authenticated user".

The gate is enforced at the **view**, and the service function is reachable by any
in-process caller — so `shift_sample_dates()` independently re-checks that the program
holds at least one `is_sample=True` project and refuses otherwise. A view that gates what
its service does not is a hole any non-view caller reopens.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Manual endpoint + service + management command (chosen)** | Consented, visible, idempotent, zero new background machinery; the command is the unit a demo deployment can schedule | Does not by itself reach the read-only hosted demo (F2) |
| B. Nightly `CELERY_BEAT_SCHEDULE` entry | Sample never goes stale anywhere, no one has to know | Every self-hosted install acquires a silent rewriter of ~50 date columns; the operator's documented pain verbatim; no dead-letter story for a bulk rewrite |
| C. Both A and B | Belt and braces | The issue explicitly calls the beat optional; shipping both by default is the thing it warned against, and B's cost is unchanged by A existing |
| D. Re-import the fixture (`load_sample` with a fresh anchor) instead of offsetting | Trivially correct — reuses F1 wholesale; cannot touch real work (F4) | Destroys every edit the evaluator made, which is the demo they were building; and "Remove sample data → Load demo data" already offers exactly this |
| E. Lazy re-anchor on read (offset dates in the serializer) | Nothing is ever written | Every consumer must re-implement it — exports, the scheduler, Monte Carlo, the WASM engine; the dates in the DB stay wrong and CPM computes on them |

D is worth stating explicitly because it remains available to the user: the existing
Remove → Load pair *is* the clean-reload path. The shift exists for the case D cannot
serve — an evaluator who has already invested edits in the demo.

## Consequences

**Easier.** A sample stays demo-ready indefinitely at the cost of one click. The offset
preserves user edits, baseline variance, burndown shape and forecast trend exactly, so
what the banner promises is what renders. Nothing new runs in the background.

**Harder.** The tier table is a maintenance obligation: a new dated column on a
loader-written model needs a tier, and nothing but the test suite will say so. A sample
loaded before this ships carries `sample_anchor_date = NULL` and cannot be shifted —
those evaluators reload, which is the honest answer and is what the endpoint's refusal
says.

**Risks.** The shift is a single bulk write over a whole program; it is bounded by one
sample program's row count (the same order as the import, which is already synchronous)
but it is not small. Mitigated by doing it in one `transaction.atomic()` with
`select_for_update()` on the program, and by the fact that F4's guarantee — a sample
program can hold only sample projects — bounds the blast radius to disposable data.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: api, web (helm deferred, see Decision 1)
- Migration required: **yes** — `0153_program_sample_anchor_date` (additive nullable
  `DateField`, no default backfill, no destructive operation)
- API changes: **yes** — `POST /programs/{id}/shift-sample-dates/`, no request body,
  returns `{shifted: bool, days: int, anchor_date: str, rows_shifted: int, projects: int}`;
  `400` when the program is not sample data or has no anchor. `ProgramSerializer` gains
  read-only `sample_anchor_date` and `sample_days_stale`.
- OSS or Enterprise: **OSS**

### Durable Execution

1. **Broker-down behaviour:** the shift itself is synchronous and has no async side
   effect of its own. Its one async consequence — CPM recalculation — goes through the
   existing transactional outbox via `enqueue_recalculate()`, so a broker outage leaves a
   PENDING `ScheduleRequest` row rather than a lost recalc.
2. **Drain task:** reuses `drain-schedule-queue` (30 s). Semantics match exactly — this is
   a plan-input change requesting a CPM pass, which is what that outbox is for. No new
   drain.
3. **Orphan window:** N/A — no new outbox table. `drain_schedule_queue`'s existing
   10-minute filter governs the rows this enqueues.
4. **Service layer:** `scheduling/services.py::enqueue_recalculate()` for the recalc;
   new function `apps/projects/seed/reanchor.py::shift_sample_dates(program)` for the
   shift itself.
5. **API response on best-effort dispatch:** synchronous `200` with the shift report. The
   recalc is explicitly *not* awaited — `recalculated_at = None` plus the existing
   "recalculating" badge is the client-visible state, so no `{"queued": true}` envelope is
   needed for a result the caller does not block on.
6. **Outbox cleanup:** reuses `schedule-requests-purge-nightly` (02:15 UTC, 7-day
   retention). No new purge.
7. **Idempotency:** the idempotency key is `Program.sample_anchor_date` itself. The delta
   is derived from it and it is advanced to today in the same transaction, so a duplicate
   execution computes a delta of zero and writes nothing. The program row is held under
   `select_for_update()` for the duration, so two concurrent shifts serialize rather than
   double-apply.
8. **Dead-letter / failure handling:** the shift is one atomic transaction — it commits
   whole or rolls back whole, and a rollback leaves `sample_anchor_date` unadvanced so the
   action is simply retryable. The recalc inherits `ScheduleRequest`'s existing retry and
   failure handling. No new dead-letter path. Note that refusal paths in the view perform
   **no writes at all**, so DRF's `set_rollback()` on `APIException` under
   `ATOMIC_REQUESTS` has nothing to discard.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1175` — **0 issues** (the ADR is
      authored in the same branch as its only implementing issue, #3481).
