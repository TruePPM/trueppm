# ADR-1495: Timesheet review — reporting line, approve / return, TimeEntry.category

## Status
Accepted. Amends [ADR-0224](0224-timesheet-week-submission-marker.md).

## Context

ADR-0224 shipped `TimesheetSubmission` as a marker with "no approver, no lock, no return" and
named the 0.5 timesheet epic (#100) as the place approval would land. Issue #4811 is that API
half. On main there was no reporting-line model anywhere, `TimesheetSubmission` held only
`user`, `week_start` and `submitted_at`, and `TimeEntry` had no category.

The change crosses an authorization boundary: for the first time one person acts on another
person's time. The threat model and enterprise-check on the issue set the requirements this
ADR records decisions for.

## Decision

### 1. The reporting line is its own user-keyed row, `timetracking.ReportingLine`

`ReportingLine(user OneToOne, manager FK, updated_by, updated_at)`, plus an append-only
`ReportingLineChange(user, previous_manager, new_manager, actor, created_at)`.

- **Not on `Resource`** (the design note's suggestion). `Resource.user` is a nullable,
  non-unique FK: a person can have no resource or several, and resources are staffing rows.
  Approval authority keyed on one of them would be ambiguous.
- **Not on `UserProfile`.** That row is written by its owner through
  `PATCH /auth/me/profile/`. A manager field there is one serializer edit away from a member
  setting their own approver, the self-grantable shape of `IsOrgAdmin`.
- **Admin-only.** `/api/v1/reporting-lines/` is `IsWorkspaceAdminStrict` on every method
  (reads too, as org structure is confidential) and refuses API tokens.
- **No self, no cycles.** `manager != user` is a DB `CheckConstraint`. The service walks the
  chain up from the proposed manager and refuses any assignment that leads back to the
  person, so mutual approval (A manages B, B manages A) and longer loops are both refused.
  Writes take a transaction-scoped advisory lock, so two concurrent edits cannot each pass
  the check and commit a loop.
- **Authority is read at action time.** Nothing stores the reviewer at submit. When a
  person's manager changes, weeks already submitted go to the new manager and the old one
  loses access immediately.
- **Enterprise seam: the write path, not a read override.** A directory sync (SCIM / LDAP)
  calls `review.set_manager()` in-process, getting the same checks and audit. A read-side
  override was considered and rejected: the review queue needs the reverse lookup (manager to
  reports), and two sources of truth for authority would disagree.
- **This deviates from the enterprise-check on the issue**, which asked for a read-override
  seam. The user confirmed the write seam instead, for the reason above: an override that
  answers "who is this person's manager" cannot also answer "who reports to me" without a
  second registration that could disagree with it, and writing synced lines into the one
  table keeps the cycle check and the change audit in force. The cost is that enterprise
  cannot supply authority without persisting it, and an admin can edit a synced line
  until the next sync writes it again; marking lines as externally managed is not part
  of this decision.

### 2. State machine, with an append-only transition log

`TimesheetSubmission` gains `status` (draft, submitted, approved, returned), `reviewer`,
`reviewed_at`, `return_reason` and `entries_digest`. `TimesheetTransition(submission, actor,
from_status, to_status, reason, created_at)` records every step; the columns on the
submission row are only a cache of the newest one.

| From | Action (actor) | To |
|---|---|---|
| none / draft / returned | submit (owner) | submitted |
| submitted | submit again (owner) | submitted (digest refreshed, no log row) |
| submitted / returned | withdraw (owner) | draft |
| submitted | approve (manager) | approved |
| submitted | return with reason (manager) | returned |
| approved | anything | refused, 409 |

- **Withdraw keeps the row** as `draft` rather than deleting it as ADR-0224's un-submit did,
  so the transition log survives. The weekly GET's `submitted` boolean keeps its 0.4 meaning
  (true for submitted and approved) and gains `status`, `reviewer`, `reviewed_at` and the
  caller's own `return_reason`.
- **Approve checks what was submitted.** Submit stores a sha256 of the week's live entries;
  approve recomputes it under `FOR UPDATE` on the submission row and answers 409
  `timesheet_changed_since_submit` on a mismatch. Submitted weeks stay editable (as in 0.4),
  so this is what stops a reviewer approving hours they never saw.
- **Return requires a reason**, refused server-side (400) when blank, and backed by a
  `CheckConstraint` (a returned row always has one).
- **The reviewer is `request.user`**, never read from the body. A non-report and a missing
  id answer the same 404, and the caller's own id never resolves.

### 3. An approved week is locked in `TimeEntry.save()`

The lock lives on the model, not in a view, because entries are written by several paths:
REST create and edit, soft delete, and timer stop. `save()` takes `FOR UPDATE` on the week's
submission row and raises `TimesheetWeekLocked` (409) for a write into, or a move out of, an
approved week. The row lock serializes it against approve: whichever commits first wins.

- `bulk_create` and `QuerySet.update` bypass `save()`. A test enumerates every such caller in
  the tree and allows only the demo seed tools; a new bypassing caller fails it.
- A running timer whose week is approved is **discarded** at stop or second-start, not
  logged and not refused, for the reason `stop_timer` already gives: a refusal would leave
  the timer impossible to stop.
- Sync is pull-only for time entries (ADR-0185 §6), so it has no write path to guard.
- **No reopen in 0.5.** An approved week cannot be edited, withdrawn or re-reviewed by anyone.
- **Accepted exception: hard deletes.** `TimeEntry.task` and `TimeEntry.user` are
  `on_delete=CASCADE`, and a database cascade never calls `save()`. Hard-deleting a task or a
  user (an admin or maintenance operation, not a product route; tasks and entries are
  soft-deleted in normal use) therefore removes that row's entries from an approved week. The
  lock covers every ORM write through `save()` and every product route; it is not a
  database-level immutability guarantee, and the docs say "every write path in the product",
  not "any route". Making approved entries survive a hard delete (`PROTECT`, or a frozen copy
  on the submission) is a larger change left for the Enterprise audit trail.
- **Pre-upgrade submitted weeks.** A week submitted under ADR-0224 takes the `submitted`
  default with no digest, which approve could never match. Migration 0006 ends with a
  `RunPython` that stamps the digest of the week's entries as they stand at upgrade (a frozen
  copy of `week_digest` in `timetracking/backfill.py`). Nothing guarded those weeks before, so
  the entries at upgrade are what the reviewer sees and approves.
- **Error bodies carry `code`.** `TimesheetWeekLocked` and `TimesheetStateConflict` answer
  `{"detail": ..., "code": ...}` with the three codes in `api/errors.md`. Stopping a timer
  discarded because its week is approved answers `409` with `code: timesheet_week_approved`
  and says the time was not logged, not "no active timer"; the status stays `409` so the web
  client clears its timer exactly as before.

### 4. `TimeEntry.category`: task, pto, admin, training

Default `task`, which is also the backfill (the column default). Only `task` is costed:
`projects.cost` filters on `COSTED_CATEGORIES`. `TimeEntry.task` stays required in 0.5, so a
PTO entry is still recorded against a task; making non-project time task-less is a separate
change with sync and reporting consequences.

### 5. Visibility, notifications, signals, agents

- **A draft week is never reviewer-visible.** The `me/reports/` routes expose only submitted,
  approved and returned weeks. A draft (never submitted, or withdrawn back to draft, including
  a returned week withdrawn) is the person's working copy: the queue row reads `status: draft`
  with `submitted_at: null` and `week_minutes: null`, identical to a week that has no row; the
  week detail answers **404** with the same body as a non-report (so it cannot tell a draft
  from an empty week, or from a person who is not a report); approve and return answer the
  same `409 timesheet_state_conflict` as a never-submitted week, with no entries. 404 rather
  than 403 for the detail because "there is no week here for you to review" is the truthful
  answer and it matches the non-report case. Project-scoped time reads are unchanged: they
  follow project RBAC, not the reporting line.
- A manager sees a report's week totals and each entry's hours and category. Task, project
  and note are shown only for projects the manager is a member of; others are marked
  `restricted`. Approving someone's time grants no read of projects the manager cannot see.
- `return_reason` is shown to the submitter and to the reviewer who wrote it, not to a later
  manager.
- Return writes an in-app Inbox item to the submitter carrying the reason; resubmit after a
  return (directly, or after withdrawing the returned week to draft) writes one to the
  person's **current** manager. Both are in-app rows only, so no email renders the reason, and
  both honor the recipient's in-app preference (`timesheet.returned`, `timesheet.resubmitted`;
  default on, email default off). Subjects are cut to the 255-character column.
- No board broadcast: a timesheet is personal, not board state.
- Every transition fires `timesheet_review_changed` through `dispatch_extension_signal()`
  with identifiers and scalars only. Receivers are savepoint-isolated; a raising receiver
  does not abort the OSS write (tested).
- **Approve and return refuse API tokens** (`IsNotTokenForTimesheetReview`, a subclass of the
  ADR-1485 scope-decision refusal). Attesting to someone's hours is a person's act. The refusal
  is marked as an identity refusal and queued as a `refused` agent-action row, so it is
  audited and explained. Submit and withdraw of one's own week keep their 0.4 posture.

### 6. Why this is OSS (enterprise-check)

ADR-1048 draws the line at *who must approve*: a single approver is OSS; a mandated approver,
a multi-step chain or org-wide policy is Enterprise. A reporting-line reviewer is set by an
admin rather than chosen by the submitter, which is closer to "mandated". It stays OSS because
it is one level, covers one person's own time inside a team an admin configured, and enforces
nothing downstream: an approved or unapproved week blocks no payroll, cost posting or other
process. This is a reading of ADR-1048, recorded here so it can be challenged.

The vocabulary is a **review** with a **reviewer**, never a "workflow" or "approval chain".

Enterprise, on top and not here: multi-level or delegated chains, escalation and auto-routing,
mandatory approval policy (approve before payroll or before cost posts), bulk approval rules,
directory-synced reporting lines (through the §1 write seam), and an immutable audit-grade
trail with retention evidence. No Enterprise affordance appears in the OSS UI.

## Alternatives Considered

| Option | Why not |
|---|---|
| Manager on `Resource` | Non-unique, nullable link to a person; ambiguous authority |
| Manager on `UserProfile` | Owner-writable row; one serializer change from self-grant |
| Lock in each view | Every new write path would have to remember it |
| Lock submitted weeks too | Breaks the 0.4 contract that submitted weeks stay editable; the digest check covers it |
| Store the reviewer at submit | A manager change would leave weeks with a reviewer who no longer manages the person |
| Reopen after approve | No requirement in 0.5; it re-opens the edit-after-approve race the lock closes |

## Consequences

- **Easier:** one guard covers every ORM write path; enterprise governance layers on a stable
  signal and write seam.
- **Harder:** `TimeEntry.save()` costs one to two extra indexed queries.
- **Risks:** a future caller using `bulk_create` / `update` on `TimeEntry` bypasses the lock;
  the enumeration test is the backstop.

## Implementation Notes
- **P3M layer:** Operations. OSS.
- **Affected packages:** api, docs. The web review queue is a separate issue.
- **Migration:** one (`timetracking.0006`), ending in the digest backfill above. Two new constraints, each with a `# safe-constraint:`
  note: the returned-has-reason check is safe because every existing row takes the
  `submitted` default; the not-self check is on a table created in the same migration. No
  `RemoveField`.
- **API changes:** `reporting-lines/`, `me/reports/` routes; `category` on time entries;
  review fields on the weekly GET and submit response. `docs/api/openapi.json` regenerated.

### Durable Execution
1. **Broker-down behavior:** N/A. All transitions are synchronous DB writes; no `.delay()`.
2. **Drain task:** N/A.
3. **Orphan window:** N/A. No `on_commit` dispatch; the extension signal fires inside the
   transaction, savepoint-isolated.
4. **Service layer:** `timetracking/review.py`.
5. **Best-effort response:** N/A. Responses are synchronous.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** a repeated submit refreshes the digest, never a second row; withdraw of a
   draft week is a no-op 204; approve and return of a non-submitted week are 409. Approve
   holds `FOR UPDATE` on the submission row while it re-hashes, and the entry-write guard
   takes the same lock, so a concurrent edit and approve serialize (tested with two threads;
   the test fails with the guard's lock removed).
8. **Dead-letter:** N/A. Validation (400), scoping (404) and state (409) surface inline.
