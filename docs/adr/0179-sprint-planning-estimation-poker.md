# ADR-0179: Sprint-Planning Estimation Poker

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class PokerSession)

## Context
Sprint Planning is where a team sizes its backlog, yet TruePPM has no in-tool way to do
it — teams leave for planningpoker.com / Miro to run estimation poker, then copy the
agreed numbers back into `Task.story_points` by hand. #863 (parent #567, the state-aware
sprint workspace) closes that gap with a right-rail **estimation poker** card on the
PLANNED sprint: the team votes on a Fibonacci scale, reveals simultaneously, discusses
outliers, and commits an agreed value that writes straight to `Task.story_points`.

### P3M layer
**Operations / Programs-and-Projects → OSS.** A single-team agile ceremony. It produces
the team's own `story_points` (which feed *their* velocity); nothing aggregates across
projects. VoC confirms the boundary: the OSS adoption cohort loves it (Jordan/PO 9🟢,
Alex/SM 8🟢, Morgan/Coach 8🟢, Priya/TM 8🟢 — the canonical PO+SM "ship it in OSS"
signal), while the out-of-cohort 3s (Janet/Marcus want a portfolio rollup, David wants
resource capacity, Sarah runs waterfall) are exactly the Enterprise/0.5/non-agile asks the
feature correctly does not serve.

### Forces (from VoC)
- **Morgan (privacy):** individual votes must never become a per-developer history a future
  PMO dashboard or export could surface as "who always sandbags." The vote record is a
  team-internal, session-scoped ceremony artifact, not a governed metric.
- **Alex/Jordan/Morgan (authority):** open/reveal/commit must follow the *facilitator*
  (Scrum Master / Product Owner facet, or Admin), not a raw `Scheduler+` access tier — the
  ceremony belongs to the team, and the team should be able to re-vote in one click.
- **Priya (resilience):** a vote must survive a page refresh, and the pre-reveal view must
  never name who hasn't voted yet (no nagging, no anchoring).
- **Alex (boundary):** committing points must not be a silent mid-sprint scope mutation —
  scope poker to the **PLANNED** sprint (pre-activation), so committing only sets the
  initial estimate.

## Decision

### 1. Models — plain ceremony rows, never synced (mirror SignalCeilingRaise*)
Both are plain `models.Model` (UUID PK), **not** `VersionedModel`, **no** `HistoricalRecords`,
and **not** added to the sync union (`sync/serializers.py` / `sync/views.py`) — exactly the
`SignalCeilingRaiseProposal`/`Vote` shape. *This is Morgan's privacy boundary, enforced
structurally:* the rows are not mobile-synced, not in any project export, and no endpoint
returns votes across sessions or by user. The vote rows are their own session-scoped audit.

```python
class PokerSessionState(models.TextChoices):
    OPEN = "open", "Open for voting"
    REVEALED = "revealed", "Revealed"
    COMMITTED = "committed", "Committed"
    CANCELLED = "cancelled", "Cancelled"

class PokerSession(models.Model):           # projects app, db_table "projects_poker_session"
    id = UUIDField(pk)
    sprint = FK(Sprint, CASCADE, related_name="poker_sessions")
    task = FK(Task, CASCADE, related_name="poker_sessions")
    state = CharField(choices=PokerSessionState, default=OPEN, db_index=True)
    committed_points = PositiveSmallIntegerField(null=True, blank=True)  # set on commit
    started_by = FK(User, SET_NULL, null=True, related_name="opened_poker_sessions")
    started_at = DateTimeField(auto_now_add=True)
    closed_at = DateTimeField(null=True, blank=True)  # set on commit/cancel
    # One live (open|revealed) session per task — a task can't be in two poker rounds at once.
    constraints = [UniqueConstraint(fields=["task"],
        condition=Q(state__in=["open", "revealed"]), name="poker_one_live_per_task")]

class PokerVote(models.Model):              # db_table "projects_poker_vote"
    id = UUIDField(pk)
    session = FK(PokerSession, CASCADE, related_name="votes")
    voter = FK(User, CASCADE, related_name="poker_votes")
    value = PositiveSmallIntegerField(null=True)  # null == "?" (unsure); else a Fibonacci card
    comment = CharField(max_length=280, blank=True, default="")
    created_at = DateTimeField(auto_now_add=True)
    updated_at = DateTimeField(auto_now=True)
    constraints = [UniqueConstraint(fields=["session", "voter"], name="poker_one_vote_per_member")]
```
`value` is validated in the serializer against the Fibonacci card set `{1,2,3,5,8,13,21}`
(or null). Comment cap 280.

### 2. State machine + endpoints
States: `open → revealed → committed` (terminal); `revealed → open` (re-vote);
`{open,revealed} → cancelled` (terminal). Every transition runs under
`select_for_update()` + a status guard (the signal-privacy `cast_ceiling_vote` idiom) so
concurrent writers converge.

| Endpoint | Who | Effect |
|---|---|---|
| `GET /sprints/{sprint_pk}/poker/` | participant (IsProjectMember) | the sprint's live session(s) + caller's own vote + tally (privacy-filtered) |
| `POST /sprints/{sprint_pk}/poker/` | **facilitator** | open a session for `{task}` (sprint must be PLANNED; task in sprint; no live session for task) |
| `POST /poker/{pk}/vote/` | **participant** (`is_team_member`) | upsert my vote (`update_or_create`); only while `open` |
| `POST /poker/{pk}/reveal/` | **facilitator** | `open → revealed` |
| `POST /poker/{pk}/reopen/` | **facilitator** | `revealed → open` (Alex's one-click re-vote; votes retained, voters adjust) |
| `POST /poker/{pk}/commit/` | **facilitator** | `{open,revealed} → committed`; body `{points}`; writes `Task.story_points`, sets `committed_points`, `closed_at` |
| `POST /poker/{pk}/cancel/` | **facilitator** | `{open,revealed} → cancelled` |

- **Facilitator** = `can_manage_scope_with_facet` (Admin+ OR Scrum-Master/Product-Owner
  facet, ADR-0078/0123) — *not* raw `Scheduler+`. This is the same gate that already
  guards sprint scope-injection accept/reject, so the PO and SM can run the ceremony
  without an Admin bump (Jordan's "let the PO commit", Alex's facilitator concern).
- **Participant** = `is_team_member` (default-team membership) — the voter roster.
- **Privacy filter (serializer, state-driven):** while `open`, the session payload returns
  the **count** of votes cast + the caller's *own* vote, never other members' values and
  never who-hasn't-voted by name (Priya). On `revealed`/`committed`, it returns every
  vote's value + voter + comment (the reveal). The caller's own vote is always returned, so
  a refresh restores the card (Priya).

### 3. Outlier surfacing — web-only pure helper
The outlier line is purely presentational, so the rule lives in one vitest-tested web
helper (no server flag, no web↔api drift risk). On the ladder `L = [1,2,3,5,8,13,21]`, with
numeric votes (nulls excluded), let `m` = median value and `i` = its index in `L`; the
local step is `L[i+1] − L[i]` (and `L[i] − L[i−1]` for the top card). A round is an outlier
when `max − min ≥ 2 × step`. The UI then renders one italic line naming the diverging
voter(s) and value — to *open* the conversation, shown only during the reveal and never
persisted as a standing record (Morgan's shaming-risk note).

### 4. Broadcast — one privacy-safe event
A single literal event `poker_session_updated` with payload `{id, task_id, state}` —
**no vote values** — is broadcast (deferred via `transaction.on_commit`, plain-string
locals snapshotted before the lambda, literal direct `broadcast_board_event` call) after
every transition *and* every vote. Web invalidates the poker query on receipt and refetches
the privacy-filtered state, so a vote-cast nudges everyone's tally without leaking values
pre-reveal. Registered in `FROZEN_WS_EVENT_TYPES` + the `websockets.md` taxonomy (the frozen
MCP contract).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Plain models + facet gate + privacy-filtered serializer (chosen)** | Mirrors the proven signal-privacy ceremony shape; structural privacy (not synced/exported); facet authority matches how teams self-organize | Two new models + migration; a small state machine to test |
| Reuse `TaskNote`/comments for votes | No new model | Wrong shape — votes need hidden-until-reveal + per-member uniqueness + a tally; would pollute the notes log |
| Raw `Scheduler+` gate for facilitator | Simplest permission wiring | Fails Alex/Jordan/Morgan — Scheduler is an access tier, not a facilitation role; the SM/PO often aren't Scheduler |
| Server-computed outlier flag | Single source | Needless API surface + web↔api drift; the value is purely presentational |
| `VersionedModel` + sync for votes | Offline poker | Directly violates Morgan's boundary (votes would sync/export as a per-dev record); poker is a live co-located/remote-synchronous ceremony, not an offline flow |

## Consequences
- **Easier:** teams size in-tool; the agreed estimate lands on `story_points` and feeds
  their own velocity/burn-up; PO+SM run it without an Admin; refresh-safe; remote-synchronous.
- **Harder:** one more small subsystem (models + 6 endpoints + a state machine) to maintain;
  the privacy boundary must be guarded by review (no sync serializer, no export, no
  cross-session vote query) — a perf/security gate check.
- **Risks:** the privacy-filtered serializer is the load-bearing control — a test must prove
  a participant cannot read others' values pre-reveal. The facet gate must deny a non-facet
  non-Admin member from reveal/commit. The `commit` write to `story_points` must stay
  PLANNED-scoped so it never reads as a silent mid-sprint scope change.

## Implementation Notes
- P3M layer: Operations / Programs and Projects
- Affected packages: api (2 models + migration + serializers + viewset/actions + services),
  web (right-rail poker card + outlier helper + hooks + WS handler), docs
- Migration required: **yes** — `projects/0095_poker_session_vote.py` (two new plain models;
  no change to Task/Sprint). migration-check applies.
- API changes: yes — `GET`/`POST /sprints/{id}/poker/`, `POST /poker/{id}/{vote,reveal,reopen,commit,cancel}/`. OpenAPI regenerated. New WS event `poker_session_updated`.
- OSS or Enterprise: **OSS** (trueppm-suite). Single-team ceremony.

### Durable Execution
1. Broker-down behaviour: the only async side effect is the `poker_session_updated` board
   broadcast — a best-effort ephemeral UI nudge like every other board event. If Redis is
   down at dispatch the event is dropped and clients reconcile on their next poker-session
   refetch. No outbox is warranted. The `commit` write to `Task.story_points` is a plain
   synchronous DB write (no CPM trigger — story_points is agile-only).
2. Drain task: N/A — no outbox row; reuses the direct `broadcast_board_event` + `on_commit`
   path shared by all board events.
3. Orphan window: N/A — no drain.
4. Service layer: new `poker_services.py` with one function per transition
   (`open_session`, `cast_vote`, `reveal`, `reopen`, `commit_points`, `cancel`), each using
   `select_for_update()` + a status guard — mirrors `signal_privacy_services`.
5. API response on best-effort dispatch: synchronous — every action returns the updated
   session (privacy-filtered). Not a `202 {"queued": true}` path; the broadcast is
   fire-and-forget after commit.
6. Outbox cleanup: N/A — no outbox. Cancelled/committed sessions and their votes are
   retained as the session-scoped ceremony record (small, bounded per sprint); no purge job
   in v1.
7. Idempotency: `vote` is `update_or_create` on `unique(session, voter)` — re-running
   converges. The state transitions (`reveal`/`reopen`/`commit`/`cancel`) run under
   `select_for_update` + a status guard, so a replay after the transition is a no-op/409,
   never a double effect. `open` is guarded by the `poker_one_live_per_task` partial-unique
   (a double-open returns the existing live session / 409). All six POST endpoints are
   therefore registered in the idempotency `EXEMPT_URL_NAMES` allowlist with this
   justification — the same treatment as the signal-privacy ceremony endpoints.
8. Dead-letter / failure handling: N/A — best-effort broadcast, no retry queue; a dropped
   event self-heals on the next refetch. There is no durable task to dead-letter.
