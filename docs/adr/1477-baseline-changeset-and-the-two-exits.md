# ADR-1477: The baseline changeset — amend entries, reasons asked after, and the two exits

## Status

Accepted (2026-11-24)

> **Implementation status (2026-11-24, at acceptance):** the *decision* stands, but **none of it
> is built yet**. Verified 2026-11-24: no `ChangesetEntry`, `BaselineDecision`,
> `record_structural_change` or `baseline-decisions` route exists anywhere under
> `packages/api/src`, `packages/web/src` or `packages/mcp/src`. `amend.py` (#2964) and
> `BaselineActivateView` behave as §Context describes. Implementation is #3150 and #4813;
> webhooks are #5121.

## Context

**P3M layer:** Programs and Projects (a single project's plan and its baseline). OSS.

A committed plan (ADR-0845, `commit_moment.py`) is edited by the same gestures that built
the draft. Since #2964 a task PATCH on a committed plan already carries an optional
`amend_reason`. It is stored as `HistoricalTask.history_change_reason` and sent to the
task's `TaskResource` assignees as a `plan.amended` notification (`amend.py`,
`TaskViewSet.perform_update`). Three things are missing:

1. **No changeset.** Reasons are scattered across history rows. Nothing gathers "what changed
   since v1, and why" into a set that can be reviewed and acted on.
2. **No second exit.** `BaselineActivateView` (`IsProjectAdmin`, ADMIN and above) can make
   any baseline active. Nothing offers *Keep v1 · let variance stand* as an equal choice, and
   nothing records either decision. UX-REVIEW §4: "A product that only offers re-baseline
   teaches people to launder slip."
3. **Structural writes carry nothing.** Only `TaskViewSet.perform_update` knows about amend,
   and a PATCH can't move a task: `parent_id` and `wbs_path` are read-only on `TaskSerializer`
   (ADR-0743). The moves happen on `indent/`, `outdent/`, `reparent/`, `reorder/`, `group/` and
   `ungroup/`, and adds and deletes happen on several routes. None of them records anything.

The interaction is settled and not re-opened here:
- #3150 §C, decisions D9–D11: no gesture waits for a reason, the reason is asked afterwards
  without a modal, and only re-baselining waits.
- The Redesign Pass 5 record, `docs/design/pass5/` frames 3A–3D and 4A.
- #4813, which merges the Rebaseline dialog into the same sheet.
- #5122, which lists the decisions made 2026-11-24.

This ADR decides the server model and the API contract those designs need.

## Decision

### 1. Two new models in `apps/projects`

**`ChangesetEntry`** holds one structural act, or one batched group of acts of the same kind.

| Field | Meaning |
|---|---|
| `id` | UUID |
| `project` | FK `Project`, CASCADE |
| `baseline` | FK `Baseline`, SET_NULL, nullable. The active baseline at creation; null when a committed project has no baseline (`is_amendable` is lifecycle-keyed). |
| `kind` | `add` \| `move` \| `delete` |
| `surface` | `grid` \| `gantt` \| `board` \| `outline` \| `api` \| `sync`. Part of the grouping key (D10: Board drags never group with Grid restructures). |
| `author` | FK user, SET_NULL. The human, or the delegating human for an agent. |
| `agent_actor` | nullable FK to the ADR-0112 `Actor` when an agent made the edit. Agents have no structural write in 0.5, so this is reserved and always null until then. |
| `task_ids` | JSON list of task UUIDs touched by the group. UUIDs, not an M2M, because a `delete` entry must outlive a purged task. |
| `task_names` | JSON list, snapshotted at act time, for the same reason |
| `reason` | text ≤ 500, **nullable**. Set once. |
| `reason_by`, `reason_at` | who answered and when, which may differ from `author` |
| `finish_before` | the project CPM finish read when the first act was applied |
| `finish_after` | nullable, stamped by the recalculation that follows (§4) |
| `opened_at`, `last_act_at`, `closed_at` | the group window |
| `resolved_by` | FK `BaselineDecision`, nullable. Set only when a v2 is taken. |

`reason_state` is derived from `reason IS NULL` and exposed read-only. It is never stored, so
it can't disagree with `reason`.

**`BaselineDecision`** holds one exit from the changeset. It is the change-control trail #4813
asks for, and it is append-only.

| Field | Meaning |
|---|---|
| `kind` | `taken` \| `kept` |
| `from_baseline` | FK `Baseline`, PROTECT. The baseline that was active. |
| `to_baseline` | FK `Baseline`, PROTECT, nullable. Set for `taken`. |
| `reason_code` | `taken` only, one of #4813's six codes: `approved_scope_change`, `sponsor_moved_commitment`, `external_delay`, `estimate_correction`, `team_change`, `calendar_change` |
| `reason` | text ≤ 500. Required for `taken`. |
| `note` | text ≤ 500, optional, for `kept` |
| `commitment_moved` | bool, default false. Records that the decision also moved the project's commitment date. **No commitment field exists on `Project` today**; #3901 introduces it, along with health as P80 against the commitment. Until #3901 lands, `commitment_moved=true` is refused with `400 commitment_not_available` and the UI hides the tick. Once it lands, `true` moves that field in the same transaction. |
| `decision` | FK `ProgramDecision`, SET_NULL, nullable. #4813's optional linked decision, which is also the link #4815's Decisions tab reads ("the baseline it led to"). It must belong to the project's program, or the request is refused with `400 decision_not_in_program`. |
| `entry_ids` | JSON snapshot of the open entries at decision time |
| `finish_at_decision` | CPM finish at decision time |
| `actor`, `created_at` | who decided and when |

`save()` refuses an update to an existing row and `delete()` refuses outright. No endpoint
edits or deletes one, and a test pins both (§7).

#4813 asked for a structured code and #2964 forbade a picker. The code applies only to the
**decision** to re-baseline, a governance act with a small known vocabulary. Per-edit amend
reasons stay free text, as #2964 requires.

### 2. Which writes create entries

A shared service, `amend.record_structural_change(project, *, kind, surface, actor, tasks,
reason=None)`, is called from every structural write path when `is_amendable(project)`:

| Path (today's code) | Kind |
|---|---|
| `TaskViewSet.perform_create`, `PhaseViewSet` create, paste-many (`PasteManyOperation`) | add |
| `TaskIndentView`, `TaskOutdentView`, `TaskReparentView`, `TaskReorderView` (`tasks/reorder/`, WBS sibling order), `TaskGroupView`, `TaskUngroupView` | move |
| `TaskViewSet.perform_destroy`, `PhaseViewSet` destroy, `tasks/bulk/` delete | delete |
| MS Project import into an **ACTIVE** project | one `add` entry per import, with `surface=import` |
| `apps/sync/upload.py` create and delete rows | add or delete, with `surface=sync`. Sync can't reparent (`upload.py` strips `wbs_path`), and the web offline outbox (ADR-1465) queues adds and moves but sends deletes online only. |

**Not structural, and creating no entry:**
- the board-column `TaskViewSet.reorder` action, which only sets `priority_rank`;
- every task PATCH, including dates, duration, owner, status and **sprint membership**;
- `PhaseViewSet` update, which renames or re-dates a phase.

Task PATCHes keep exactly today's #2964 behavior: an optional `amend_reason` goes into
history and notifies assignees. Sprint membership already has its own trail and notices
(ADR-0102 scope injection, ADR-0412 lead notifications). **Pass 5 Q3.9 is already met on `main`.** ADR-0412's mid-sprint membership notice
(`services.notify_sprint_membership_change`, `_sprint_lead_recipient_ids`) already goes to
`role >= ADMIN` plus the ADR-0078 Scrum Master and Product Owner facet holders, minus the
actor; #2897 added the facet half. This ADR changes nothing there.

A multi-select act — one `bulk/` call, one paste-many, or one `indent/`, `outdent/` or `reorder/` call with several rows — is **one** entry.

### 3. Grouping, server-side

`record_structural_change` takes a `select_for_update` on the newest open entry for
`(project, kind, surface, author)`. It absorbs the new act when all of these hold:
- that entry has no reason;
- `closed_at` is null;
- `now - last_act_at ≤ 120 s`.

Otherwise it opens a new entry.

A write may carry `amend_group: "new"` to force a new entry. The client sends it after the
events the server can't see: a mode or surface change, Review opened, or page unload. Those
close a group per D10.

Answering an entry sets `closed_at`, and a closed entry never absorbs. The key survives a
reload because it lives in the database, not the client (#3150 "what is still open").

**Undo:** `amend.retract(...)` is called from both undo paths, `TaskViewSet.restore` (trash)
and `structural_operation_services.undo_structural_operation` (group, ungroup, reparent):
- it removes the tasks from their entry's `task_ids`, and deletes the entry when that empties
  it, reason included;
- otherwise it clears `finish_after`, so the next recalculation re-stamps the reduced effect
  (D10, "undoing one act decrements … its date effect").

### 4. Finish impact

- **`finish_before`** is read synchronously, the same max `early_finish` read the Review sheet
  shows.
- **`finish_after`** is stamped by the recalculation that the edit already enqueues through
  `scheduling/services.py::enqueue_recalculate()`. In the same transaction that persists the
  new dates, the recalc task sets `finish_after` on this project's entries whose
  `finish_after IS NULL` and `last_act_at ≤` the run's input snapshot time. No new task, no
  new dispatch.
- **Provenance:** reads route impacts through `stamp_answer`, so each carries `_provenance`
  with `engine_version`, `input_hash` and `computed_at` (`scheduling/answer_stamp.py`, ADR-0112 §2).
- **Unknown impact:** if the project has no CPM run yet, `finish_after` stays null and the
  sheet says "impact not computed yet". It never guesses.

### 5. API

| Method and path | Who | What |
|---|---|---|
| `GET /projects/{id}/changeset/` | project read | Open entries (unreasoned first), counts by `reason_state`, net effect against the active baseline, `_provenance`, plus `last_kept_at` and `entries_since_kept`. When `entries_since_kept` is 0 after a Keep v1, the client demotes Review (Pass 5 Q3.1); one new entry promotes it. |
| `PATCH /projects/{id}/changeset/entries/{eid}/` `{reason}` | **Scheduler and above** | Sets the reason once. A second write returns `409 reason_already_set`. |
| `GET /projects/{id}/baseline-decisions/` | project read | The trail, newest first |
| `GET /projects/{id}/baseline-decisions/preview/` | **Admin and above** | What a `taken` would do: `{finish_from, finish_to, delta_wd, milestones_moved: [{id, name, from, to}], tasks_with_new_dates: {count, of}, commitment_moves}`. It is computed by `baselines.decide(..., dry_run=True)`, the same function the POST runs. |
| `POST /projects/{id}/baseline-decisions/` `{kind, reason_code?, reason?, note?, commitment_moved?, decision?}` | **Admin and above, human session only** (`IsNotTokenAuthenticated`) | One transaction. The body carries `expected_open_count`. If the open set changed since the sheet loaded, the POST is refused with `409 {"code":"changeset_changed","open_count":N}` and the sheet reloads (Q4.3). `taken`: refuses `409 {"code":"changeset_unreasoned","entries":[…]}` while any open entry has no reason; captures and activates v(n+1); resolves the open entries. `kept`: writes the row; the entries stay open. |

Task writes keep `amend_reason` as an optional field. When it's present on a structural write,
it becomes the new entry's reason.

**The bypass is closed.**
- On a project whose `lifecycle` is ACTIVE, `BaselineActivateView` returns
  `409 {"code":"use_baseline_decision"}`.
- Creating a *non-active* named baseline for comparison stays allowed, because it isn't a
  re-baseline.
- Drafts are unchanged.
- This is the threat model's top risk (Appendix).

**Roles.**
- **Decided 2026-11-24 by the maintainer: Admin and above.** Taking v2 and keeping v1 keep
  the existing `IsProjectAdmin` floor (ADMIN and OWNER), the floor `ProjectCommitView` and
  `BaselineActivateView` both hold. This supersedes Pass 5 Q3.2's "Owner, Admin and Scheduler"
  in #3150 and #4813.
  - Taking v2 changes what variance is measured against, so it sits with the role that can
    commit the plan in the first place.
  - Keep v1 gets the same floor, so neither exit is easier to reach than the other.
  - Widening to Scheduler later is one permission class plus an `rbac-check`.
- Schedulers can answer reasons. Members can't, and the UI never asks them. A Member's
  structural write still creates an unreasoned entry for the plan owner.

**Agents and the decision.** Re-baselining is a governance decision, so it stays with a person. A token-authenticated call to `POST baseline-decisions/` is refused with 403 and records an `AgentAction` with verdict `refused` and reason `policy`. That is the mechanism `IsNotTokenAuthenticated` already uses (`_mark_policy_refusal`) and ADR-1460 records for capability writes (ADR-0112 §1.3). A single-approver path for agent-proposed re-baselines (ADR-0112 RC4) is a later decision, not this ADR's.

**MCP.** Two read tools, `get_changeset` and `list_baseline_decisions`, beside the existing
`list_baselines` (`packages/mcp/.../tools.py`). There are no write tools, because agents can't
write in 0.5.

**Phone (Pass 5 §4).** The phone uses the same endpoints. "Copy link" needs nothing new. "Email it to me" (Q4.2) is still open on #3150 and adds no route here.

**Real-time.** A `changeset.updated` board event carries `{project_id, open_count,
unreasoned_count}` and **no reason text**, and clients refetch. It is sent through
`broadcast_board_event()` inside `transaction.on_commit()`.

### 6. Notifications

**The audience (Pass 5 Q3.3):**
- `TaskResource` assignees of the touched tasks, minus the actor (`amend.notify_amend`, as
  today);
- the assignees of **downstream** tasks whose finish the edit moved. They are known only
  when `finish_after` is stamped (§4). The recalculation task, already running in a Celery
  worker, calls `amend.notify_downstream(entries)` **synchronously inside its own
  transaction**, after the stamp. That function writes the notification rows through
  `create_event_notifications_batch` directly, with no `transaction.on_commit` and no new
  dispatch, deduped against the first group by the `(entry_id, recipient)` idempotency key.
  If the recalc transaction rolls back, the rows roll back with the stamp, which is the
  intended coupling;
- once capacity pools exist (ADR-1461, #3122), the manager of an assigned person's pool, by
  the same rule.

`record_structural_change` notifies each recipient **once per entry**. Absorbed acts dedupe
on `(entry_id, recipient)` through the notification's idempotency key, so a batched drag of
five cards sends one notice, not five.

Answering a reason later sends nothing (D11: "notified once, on the change"). The event type
stays `plan.amended`, which is in-app by default and email off, so push only reaches people
who opt in. "Digest" means the Inbox groups `plan.amended` items per entry; this ADR adds no new
delivery channel.

### 7. Invariants pinned by tests

- An unreasoned open entry blocks `taken` in the API, not only in the UI.
- `kept` is never refused for unreasoned entries.
- `BaselineDecision` rows can't be updated or deleted.
- `ChangesetEntry.reason` can't be overwritten.
- Activating a baseline on an ACTIVE project outside `baseline-decisions/` is refused.
- Every path in §2's table creates exactly one entry per act or batch, and every path in its "not structural" list creates none. The test enumerates the route names from `urls.py`, so a new structural route fails it until it is classified.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Own models (chosen)** | Queryable set, per-entry reason state, survives a reload, a trail with integrity rules | Two tables |
| B. Changeset rows on `Baseline` (JSON) | One table | Concurrent appends race on one JSON column, the "needs a reason" state can't be queried, and immutability is unenforceable per entry |
| C. Derive the changeset from `HistoricalTask` rows tagged `amend:` | No new storage | History can't express grouping, nullable-then-set reasons, or resolution. Reconstructing a set from history on every read is slow and ambiguous. |
| D. Required reason at write time (the prototype's `amendGuard`) | Simple | Rejected by #3150 D9 ("considered and rejected — do not re-propose") |
| E. Let Schedulers take v2 (Pass 5 Q3.2) | Matches the canvas and the issues' first text | Widens an authorization boundary that commit and activate both hold at ADMIN. Rejected by the maintainer on 2026-11-24. |

## Consequences

- **Easier:** answering "what changed since we agreed, and why" is one read, for people and
  agents alike. A re-baseline can't skip its reasons. Keeping v1 becomes a recorded decision
  instead of an absence.
- **Harder:**
  - Seven write paths call one service. Missing one is the failure mode, and the §7 test
    enumerates them.
  - `BaselineActivateView` changes behavior for active projects (a 409), which any script
    activating baselines on committed projects will hit. That's deliberate. It goes in the
    changelog under `changed`, and in `docs/api/`.
- **Risk:** the recalc stamping `finish_after` adds a write to the recalculation transaction.
  It's bounded to this project's open entries with a null `finish_after`, behind an index on
  `(project, finish_after) WHERE resolved_by IS NULL`.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: api, web, mcp
- Migration required: yes. Two new tables, no backfill. Committed projects start with an empty
  changeset, and existing `amend:` history reasons stay in history.
- API changes: yes, §5. One existing endpoint (`BaselineActivateView`) changes behavior on
  ACTIVE projects.
- OSS or Enterprise: OSS. Approval chains on these decisions are Enterprise (ADR-1048, #3337).
  This is a trail, not an approval.

### Durable Execution
1. **Broker-down behavior:** no new Celery dispatch.
   - Entry writes and decisions are synchronous DB writes.
   - Notifications reuse `amend._emit_amend_notifications` through `transaction.on_commit`,
     best-effort by design (a notification failure must never revert an accepted edit), and
     already present in `on-commit-baseline.txt` as **unclassified** (#5082). This ADR adds callers of `notify_amend`, not new `on_commit` sites, so the baselined count doesn't rise. Downstream notices (§6) are written inside the recalculation task's own transaction, with no `on_commit` and no new dispatch. Auditing that callback into the registry stays with #5082.
   - The recalc is dispatched only through `enqueue_recalculate()`'s outbox.
   - Webhooks are #5121, through the webhook outbox.
2. **Drain task:** none new. The recalc reuses the schedule-request drain.
3. **Orphan window:** N/A. No new outbox category.
4. **Service layer:** new `amend.record_structural_change`, `amend.retract`, and
   `baselines.decide(...)`. `decide` captures v(n+1) with a new `baselines.capture(project, user, name)`. It is extracted from the capture half of `commit_moment.commit_project`, including the ADR-0845 calendar snapshot (`_calendar_snapshot`), and `BaselineViewSet.create` reuses it too, so there is one capture. The new baseline is named `Baseline v{n}`, where n counts the project's baselines captured at commit or by a decision. The recalc is called only through `enqueue_recalculate()`.
5. **API response on best-effort dispatch:** synchronous 200/201. `finish_after` arrives later
   and is null until then.
6. **Outbox cleanup:** N/A.
7. **Idempotency:**
   - `POST baseline-decisions/` uses `IdempotencyMixin`, like `BaselineActivateView` today.
   - `finish_after` stamping is conditional on `IS NULL`, so a re-run is a no-op.
   - The reason PATCH is set-once.
8. **Dead-letter / failure handling:** N/A. Recalc failure handling is unchanged, and an
   entry whose recalc never succeeds keeps `finish_after = null`, shown as not computed.

### On Acceptance
- [x] `python3 scripts/adr-accepted-issue-sweep.py --adr 1477`: **0** issues, because the
      issues named this ADR only in comments when the sweep ran.
- [x] Rewritten by hand, each led by a dated correction note: **3** (#3150, #4813, #5122).
      Their titles still describe the problem accurately, so the titles were kept.

## AI review (2026-11-24, before implementation)

**Verdict:** AI-ready after the two changes below.

| Check | Verdict | Change made |
|---|---|---|
| 1 API-first / MCP | PASS | The changeset, decisions and impact preview are REST reads, with `get_changeset` and `list_baseline_decisions` as MCP reads |
| 2 Provenance | PASS | Impacts carry `_provenance` through `stamp_answer` |
| 3 Write safety | GAP → fixed | `POST baseline-decisions/` is human-session only. Agent attempts are refused and audited as `AgentAction` with verdict `refused` and reason `policy`. |
| 4 Decision memory | GAP → fixed | `BaselineDecision.decision` links #4813's optional `ProgramDecision`, so "why did we re-baseline" is linked to the program's decision record |
| 5 AI boundary | PASS | The trail and single-human decision are OSS. Approval chains and notarized retention are Enterprise (ADR-1048, #3337). |

## Appendix — Threat model (STRIDE, run 2026-11-24 before this ADR)

**Assets.**
- `ChangesetEntry.reason`: internal. It may name people or vendors.
- `BaselineDecision`: internal, and integrity-critical, because it is the change-control
  evidence.
- The active-baseline pointer: integrity-critical. It decides what variance is measured
  against.
- The commitment date, once #3901 adds it: integrity-critical.

**Boundaries crossed.**

| Boundary | Obligation |
|---|---|
| 1: Internet ↔ API | New write endpoints. Auth plus project role, as in §5. |
| 2: API ↔ DB | One transaction per decision, and a set-once reason |
| 4: Redis pub/sub | The board event carries counts only, never reason text |
| Sync upload | Uses the same service, so offline edits are recorded, not exempt |

**STRIDE.**

| Asset | Threat | Mitigation |
|---|---|---|
| Active baseline | **Tampering / EoP:** re-baseline through `BaselineActivateView` with no reason and no decision row | §5: 409 on ACTIVE projects; the only path is `baseline-decisions/` at ADMIN |
| Decision trail | **Repudiation / Tampering:** edit or delete a decision | Append-only model, no route, test-pinned. DB-superuser edits are accepted risk (outside the app's trust boundary). |
| Entry reason | **Tampering:** a later user rewrites an answered reason | Set-once, `409 reason_already_set` |
| Entry reason | **Information disclosure:** reason text broadcast to every subscriber | Counts-only event; text only over REST to project readers |
| Entry reason | **Information disclosure:** a reader outside the project | Project-scoped viewsets (`ProjectScopedViewSet`), with the same read floor as task history |
| Changeset | **Spoofing:** an agent's edit appears human | `agent_actor` and `author` (`on_behalf_of`) are both stored, per ADR-0112 |
| Changeset | **DoS:** unbounded entries from scripted moves | Grouping collapses bursts, the reason is capped at 500, existing write throttles apply, and the indexed read lists open entries only |
| Commitment date (#3901) | **Tampering:** a decision silently moves the commitment | `commitment_moved` defaults false, is refused until #3901's field exists, and is recorded on the trail row |
| Sync | **Bypass:** offline structural edits skip the changeset | §2 covers `upload.py`, and §7's test includes it |

**Top 3 risks.**
1. The existing activate path bypassing the loop. Mitigated in §5.
2. A structural write path missed by the service, giving silent edits. Mitigated by the §7
   enumeration test.
3. Reason text leaking through the broadcast. Mitigated by the counts-only payload.

**Decisions this handed the architect.** Keep the ADMIN floor (§5, accepted). Make reasons
set-once (accepted). Counts-only broadcast (accepted).

**SOC 2 mapping.**
- Append-only decisions plus actor and timestamp: CC7.2 (monitoring), CC8.1 (change
  management).
- Role floors on decisions and reasons: CC6.1 (logical access).
- Counts-only broadcast: CC6.7 (restricting transmission).
