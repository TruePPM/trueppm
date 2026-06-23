# ADR-0165: Project + Sprint Decisions Views with Team-Owned Oversight Consent

## Status
Proposed

## Context
TaskNotes (ADR-0143, #740) ship a per-author "why / decision log" on a task. The
model already carries a `decision = BooleanField(default=False)` column, added by
#740 as a **read-only seam** for this issue. #748 (split from the #476 task-collaboration
epic) is the *Decision half*: make the flag toggleable, and surface a filtered view of
the decisions a team has recorded — both across a project and scoped to a sprint.

A decision log is the durable answer to "why did we change scope / why did we choose
this approach". Three personas drive it (VoC panel, this feature):

- **Alex (Scrum Master, 8/10 🟢)** — at Sprint Review the question "why did we drop that
  story?" should be answerable without trawling Slack/Confluence. He needs **closed**
  sprints to stay browsable, not just the active one.
- **Morgan (Agile Coach, 8/10 🟢)** — *the team* must own whether oversight/PMO readers
  see their decisions, not management. "Default-closed upward visibility with explicit
  team consent is the one design decision most hybrid tools get backwards." Both the
  project and sprint views must enforce the **same** gate (the sprint view must not be a
  looser side-door), and the realtime broadcast must not leak a decision to an
  oversight-connected client before consent.
- **Priya (Team Member, 7/10 🟢)** — one tap on a note she's already writing, **no** push
  notification on the toggle.

The three low scores (Janet 3, Marcus 3, David 2) are all out-of-cohort: they ask for a
*portfolio-level* Decision rollup, audit-trail immutability, and resource signals — all
explicitly deferred to Enterprise (or to 0.5) by the issue itself. Their 🔴 confirm the
OSS boundary is drawn correctly rather than signalling a rescope.

### P3M layer
**Programs and Projects / Operations → OSS.** A single-project decision log with a
single-project, team-owned consent toggle. Cross-project Decision rollup, audit-trail
immutability, and Decision lifecycle states are out of scope (Enterprise / deferred).
The consent toggle is **not** org policy — it is the team's own upward-exposure switch
within one project. It pairs cleanly with the eventual Enterprise PMO rollup as a
supply-side opt-in, exactly like `get_shared_team_signals()` (ADR-0104).

## Decision

### 1. Decision toggle — mirror the `pin` action
Add `POST /projects/{project_pk}/tasks/{task_pk}/notes/{pk}/decision/` to
`TaskNoteViewSet`, a structural copy of the existing `pin` action:

- Writer gate `IsProjectMemberWrite` (Member+) + `IsProjectNotArchived` — flagging a
  decision is curation, like pinning, not authorship; any project writer may toggle it.
- Toggles `TaskNote.decision`; `save(update_fields=["decision"])`.
- `decision` stays **read-only in `TaskNoteSerializer`** (writable only via this action,
  exactly as `pinned` is writable only via `pin`).
- Broadcasts `task_note_decision_toggled` to the board group, deferred with
  `transaction.on_commit()`, snapshotting plain values before the lambda (broadcast-check
  H-1). Payload `{id, task_id, decision}` — no note body (the body is never in a board
  event; ADR-0124 privacy idiom).

**`server_version` is deliberately NOT bumped.** `TaskNote` is intentionally **not** a
`VersionedModel` and is not in the sync union (ADR-0143: immutable rows make
`server_version` moot, and there is no mobile consumer yet). The #748 acceptance criterion
"bumps server_version" was written before that modelling decision landed; clients reconcile
the toggle via REST refetch + the WS broadcast, per ADR-0143. This is a documented,
intentional deviation from the issue text, not a gap.

### 2. Two views, one endpoint, one gate
Add `@action(detail=True, methods=["get"], url_path="decisions")` on `ProjectViewSet`:

`GET /projects/{project_pk}/decisions/?sprint=<sprint_uuid>`

- Returns decision-flagged, non-deleted notes across the project:
  `TaskNote.objects.filter(task__project_id=pk, is_deleted=False, decision=True)`.
- Optional `?sprint=<uuid>` filters to `task__sprint_id=<uuid>` — this single param
  serves **both** required views:
  - **Project Decisions view** = no param → every decision in the project, **including
    closed sprints** (Alex), `select_related` task + sprint so the client can group/sort
    by sprint.
  - **Sprint Decisions view** = the web passes the **active** sprint's id (resolved
    client-side from the sprint already in context). "Active sprint window" semantics live
    in the caller; the API stays a simple, composable filter.
- Ordering: `task__sprint__start_date DESC NULLS LAST, -created_at` — newest sprint first,
  newest decision first within a sprint (sortable-by-sprint per the AC).
- Pagination: project-default `PageNumberPagination` (page size 50). A decision log is a
  bounded, sortable list, not a time-ordered event stream, so keyset (board-activity
  style) is unnecessary complexity.
- Serializer: a read-only `DecisionNoteSerializer` = `TaskNoteSerializer` fields + nested
  `task` mini (`id`, `title`) + `sprint` mini (`id`, `name`/number, `state`) for grouping.

### 3. Visibility gate — `ProjectDecisionsPolicy` (new 1:1 model)
The signal-privacy ladder (ADR-0104) is the wrong shape here: its rungs are
team→SM→PM→program, its default *excludes* the PM, and "PMO" above PM is `PROGRAM_SHARED`
(cross-team rollup = Enterprise). #748 needs **team + PM visible by default**, and a single
**team-admin consent toggle** (the issue says "team-admin consent", not a team-wide
ratification vote). Reusing the signal machinery would mean a four-rung ladder and a
majority-vote ceremony for a two-state switch — heavier and semantically wrong (a decision
log is not a team-health *metric* with a gaming/surveillance pressure profile).

New model, mirroring the `ProjectGuardrailPolicy` / `ProjectSignalPrivacyPolicy` idiom:

```python
class ProjectDecisionsPolicy(VersionedModel):
    project = OneToOneField(Project, on_delete=CASCADE, related_name="decisions_policy")
    # Default-closed upward exposure (Morgan): the project Decisions view is visible to
    # team members and the PM by default; an oversight reader (a project member who is
    # NOT on the default team and is below ADMIN) sees it only when a project admin has
    # opted in here. This is single-project, team-owned consent — never org policy.
    oversight_visible = BooleanField(default=False)
    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)
    objects = models.Manager()
```

Created lazily via `get_or_create` on first read (no data migration / backfill).

**Read gate** (applied identically in the `decisions` action **and**, by the same helper,
to keep the views congruent):

```
can_read_decisions(request, project_id, policy) :=
    role := _membership_role(request, project_id)
    role is not None AND (
        role >= Role.MEMBER          # Team Member..Project Admin = "team + PM" — default audience
        OR policy.oversight_visible  # team-admin opted oversight readers in
    )
```

**Role — not team membership — is the discriminator.** Every `ProjectMembership` mirrors
onto the project's default team on commit (`teams/signals.py`), so `is_team_member` is true
for *every* project member and cannot tell a read-only observer apart from a contributor —
it would make the gate a no-op. The Role ladder (ADR-0072) can: `VIEWER = 0`,
`MEMBER = 100` ("Team Member"), `ADMIN = 300` ("Project Manager"), and the **1–99 band is
reserved for read-augmented/auditor roles** — exactly the oversight band. So "team + PM" is
`role >= Role.MEMBER`, and a Viewer (or an Enterprise auditor role in 1–99) is the
single-project stand-in for a PMO/oversight reader, gated until the team opts in. Uses only
`_membership_role` (access/permissions.py) — no new permission primitive.

**Consent write** — `GET`/`PATCH /projects/{project_pk}/decisions-policy/` (APIView,
mirroring the signal-privacy view shape). `PATCH {oversight_visible: true|false}` gated to
`role >= Role.ADMIN` (`IsProjectAdmin`). Admin is the team-admin authority in the OSS
single-project model.

> **Honored tension (Morgan):** Morgan's ideal is *the whole team* consenting, not a single
> admin. The issue text specifies "team-admin consent", and OSS per-project RBAC has no
> team-vote primitive for non-signal resources, so consent is an Admin+ toggle for 0.3. A
> future enhancement could route this through the ADR-0104 ceiling-raise vote machinery if
> teams want full ratification; the boolean is forward-compatible (the vote would simply
> become the writer of `oversight_visible`).

### 4. Broadcast safety (Morgan #3)
`task_note_decision_toggled` goes to the **board group**, whose subscribers are project
board members — the same audience as every existing `task_note_*` event. The visibility
gate governs **REST reads** of the *Decisions view*, not the board event: a toggle event
says only "note X's decision flag changed" to people already on the board, and carries no
note body. There is no transport-layer path by which an oversight reader receives a
decision they could not already see on the board, so the gate cannot be bypassed over the
socket. The gate's job is to suppress the *aggregated Decisions list*, and that list is
REST-only.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. `ProjectDecisionsPolicy` boolean + Admin toggle (chosen)** | Matches the issue's "team-admin consent" exactly; two-state switch is the real requirement; isolated 1:1 model, lazy-created, no backfill; reuses `is_team_member`/role helpers | One small additive migration; single-admin consent slightly weaker than full team ratification (noted) |
| B. Reuse `ProjectSignalPrivacyPolicy` "decisions" pseudo-signal | Zero migration (JSON map); inherits team ratification vote | Wrong shape: ladder excludes PM by default, "PMO" rung is cross-team `PROGRAM_SHARED` (Enterprise); a decision log is not a team-health metric; heavy vote ceremony for a 2-state toggle |
| C. Boolean field directly on `Project` | No new model | `Project` is a central high-traffic model; adding visibility flags there breaks the established per-concern policy-model idiom; heavier blast radius |
| D. Two separate endpoints (project + sprint) | Explicit | Duplicated gate logic; risks the sprint view drifting to a looser default (the exact thing Morgan flagged) |

## Consequences
- **Easier**: a team gets a durable, low-friction decision log with one tap; closed-sprint
  decisions stay recoverable; the team owns upward exposure; a future Enterprise PMO rollup
  has a clean OSS opt-in to consume.
- **Harder**: one more 1:1 policy model + migration to maintain; the consent semantics
  (single-admin vs team-vote) is a known simplification to revisit if Morgan-type teams ask.
- **Risks**: the read gate must be enforced server-side in the action (not UI-only) — an
  rbac-check + security-review gate confirms a non-team sub-Admin member is suppressed. The
  `?sprint` filter must not become a hole that bypasses the gate (the gate runs before any
  filtering).

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api (model + migration + serializer + 2 views), web (Decision chip +
  Decisions view + consent control), docs
- Migration required: **yes** — `projects/0094_project_decisions_policy.py` (additive: one
  new 1:1 model, no change to `TaskNote`; `decision` column already exists). migration-check
  gate applies.
- API changes: yes — `POST .../notes/{pk}/decision/` (toggle); `GET /projects/{id}/decisions/`
  (list, `?sprint=`); `GET`/`PATCH /projects/{id}/decisions-policy/` (consent). OpenAPI
  regenerated.
- OSS or Enterprise: **OSS** (trueppm-suite). Single-project, team-owned consent.

### Durable Execution
1. Broker-down behaviour: the only async side effect is the `task_note_decision_toggled`
   board broadcast. Like every existing `task_note_*` event (ADR-0143), it is a **best-effort
   ephemeral UI nudge**, not outbox-durable: if Redis is down at dispatch the event is
   dropped and clients reconcile on their next REST refetch of the note/Decisions list. The
   list endpoint is a pure read with no side effects. No outbox is warranted.
2. Drain task: N/A — no outbox row is written; reuses the existing direct
   `broadcast_board_event` + `transaction.on_commit` path shared by all note events.
3. Orphan window: N/A — no drain.
4. Service layer: the toggle is a one-line model write in the action (mirrors `pin`); no
   `services.py` dispatch function is needed. The read gate is a new helper
   `can_read_decisions(user, project_id, policy)` co-located with the policy model/services.
5. API response on best-effort dispatch: the toggle returns `200` with the updated
   `TaskNoteSerializer` (synchronous write; the broadcast is fire-and-forget after commit) —
   identical to `pin`. Not a `202 {"queued": true}` path.
6. Outbox cleanup: N/A — no outbox.
7. Idempotency: the toggle is last-write-wins on a single boolean; re-running it just flips
   state and re-broadcasts, and clients reconcile from REST — duplicate broadcasts are
   harmless. The consent PATCH is idempotent (sets a boolean to the requested value).
8. Dead-letter / failure handling: N/A — best-effort broadcast, no retry queue. A dropped
   board event self-heals on the next refetch; there is no durable task to dead-letter.
