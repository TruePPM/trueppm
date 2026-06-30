# ADR-0118: Sprint Review — Accepted-vs-Not Breakdown + Demo-Ready List

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class SprintTaskOutcome)

> **Extends ADR-0176** (Sprint Review API Foundation). ADR-0176 built the
> consolidated `/outcome/` read, the `SprintTaskOutcome` membership-at-close
> snapshot, `goal_outcome` (#983), and velocity-delta/burn (#984); #567 shipped
> the `SprintClosedOutcome` UI. This ADR adds the **only two pieces #924 still
> needs** — an *accepted-vs-not-accepted* breakdown and a *demo-ready list* — as a
> purely additive layer on that foundation. It does not re-decide anything in
> ADR-0176. Privacy composes with **ADR-0104** (velocity signal gate); acceptance
> criteria are **ADR-0105**.

## Context

The 0.3-readiness review (2026-05-31) found the agile end-to-end flow has **no
Sprint Review / demo surface distinct from the retro**. Sprint Review is Jordan's
(PO) acceptance ceremony — *what did we commit to, what did the PO accept, and
what will we walk stakeholders through* — and a design-partner PO/SM "notices this
hole on day one." #924's acceptance criteria: at close the review shows
**accepted/not-accepted**, a **demo list**, and **goal-met status**; it is
**read-only shareable to the PM (Sarah) without exposing per-team velocity**.

Of those three, **goal-met already ships** (`goal_outcome` in the `/outcome/`
read) and **velocity-safe sharing already holds** (the read is member-readable and
ADR-0104 nulls the velocity block + the per-task `story_points` for the PM band).
So only two genuinely-new pieces remain, both additive to the existing read.

**Grounding (verified 2026-06-11).** `snapshot_sprint_task_outcomes()`
(`services.py:918`) writes a `SprintTaskOutcome` row for **every** task linked at
close — including `disposition=COMPLETED` — so the *shipped* stories are already
snapshotted, not just the didn't-ship set. `SprintTaskOutcome` is an unsynced
append-only `models.Model` (no `server_version`). `AcceptanceCriterion`
(`models.py:1349`, per-task `met`/`met_by`/`met_at`) has **no sprint-level
aggregation** today.

**P3M layer**: Programs and Projects / Operations — single-project agile ceremony.
**OSS.** No cross-project aggregation; nothing crosses the Apache-2.0 boundary.

## Decision

### §1 — Accepted-vs-not-accepted: a server-computed three-bucket summary

A story's acceptance is **derived live from `AcceptanceCriterion.met`** — not
snapshotted — because **the review *is* when acceptance happens**: the PO ticks
criteria during the ceremony and the counts update. Three buckets (a story with
criteria is never silently "accepted"; coverage gaps are surfaced, which is the
whole point of the ceremony for Jordan):

- **accepted** — the story has ≥1 acceptance criterion and **all** are met
  (`met_count == total ∧ total > 0`).
- **not_accepted** — the story has ≥1 criterion and **not** all are met (includes
  done-but-rejected *and* not-done committed work).
- **no_criteria** — the story has zero acceptance criteria. A distinct bucket, not
  folded into "accepted" — it tells the PO where acceptance rigor is missing.

**Task set** (mirrors the existing `didnt_ship` dual-source exactly):
- **Closed sprint** → the immutable at-close membership = `SprintTaskOutcome` rows
  (`disposition` ∈ completed/carried/dropped). Each row's `task` FK is followed to
  read the task's **current** `AcceptanceCriterion.met` state (live, so in-review
  ticks count). A row whose `task` was hard-deleted (`task=NULL`) falls into
  `no_criteria` (its criteria are gone) and is logged, not crashed.
- **Provisional** (ACTIVE/PLANNED) → the live committed task set, same as
  `didnt_ship`'s provisional branch.

**Points are gated; counts are not.** `accepted_points` / `not_accepted_points`
are nulled for a reader below the velocity audience — reusing the **same
`velocity_readable` flag** `sprint_outcome_payload()` already computes
(`services.py:1137`) for the velocity block and `didnt_ship` story_points. The
*counts* (`accepted_count` / `not_accepted_count` / `no_criteria_count`) always
render — they are the milestone-health carve-out (ADR-0104: aggregates that are
not point-throughput stay visible). This keeps "the PM reads the review without
seeing velocity" true: Sarah sees *how many* stories the team accepted, never the
point throughput she'd need to back into velocity.

Exposed under a new top-level `review` block on the outcome payload (additive — no
existing field changes):

```
review: {
  accepted_count, not_accepted_count, no_criteria_count: int,   # always
  accepted_points, not_accepted_points: int | null,             # gated like velocity
  shipped: [ { task_id, task_short_id, task_title,
               story_points: int|null,                          # gated
               acceptance: { met: int, total: int },            # the badge
               demo_ready: bool } ],                            # §2
  demo_list: [ task_short_id … ]                                # §2, server projection
}
```

`shipped[]` = `SprintTaskOutcome` rows with `disposition=completed` (the demo/
acceptance candidates), so the UI renders the breakdown badges and the per-story
demo toggle from one block.

### §2 — Demo-ready list: a `demo_ready` flag on `SprintTaskOutcome`

**Decision: `demo_ready: BooleanField(default=False)` on `SprintTaskOutcome`.**
Rationale against the alternatives:

- It is **sprint-scoped** — "demo this story in *this* sprint's review" is the
  correct semantics; a boolean on `Task` (Alternative A) leaks across every sprint
  the task touches and isn't a property of the task itself.
- The rows **already exist** at review time. The Sprint Review is a closed-sprint
  ceremony (`SprintClosedOutcome` renders for `COMPLETED`), and
  `SprintTaskOutcome` rows are written at close — so demo curation on the closed
  sprint has rows to flag. (Provisional sprints have no rows yet; demo curation is
  unavailable until close, which matches the ceremony's timing — you demo what
  shipped, known at close.)
- It **survives** retention + task hard-delete (the row is denormalized), unlike
  the 90-day `HistoricalTask` trail.

`demo_ready` is a **review-time curation field, mutable**, co-located on an
otherwise close-immutable audit row — the close-snapshot fields stay immutable;
only this post-close flag toggles. `SprintTaskOutcome` has no `server_version`
(unsynced online-read model), so the toggle is a plain field update with no sync
bump.

**Write path** — `POST /api/v1/sprint-task-outcomes/{id}/toggle-demo/` (or a thin
`SprintTaskOutcomeViewSet` detail action), body `{demo_ready: bool}`. **Member+,
team-owned** (the team curates its own demo; same gate as the retro board and
acceptance criteria — not an Admin/PMO act). Object-level RBAC resolves the
project via `outcome.sprint.project_id` (a `project_id` property, the same idiom
RetroBoardItem uses). On commit, **best-effort `broadcast_board_event`** (`demo_
toggled`, deferred with `transaction.on_commit`) so co-viewers' review refetches;
the model is unsynced so there is no offline delta — the online refetch is the
sole propagation, matching the `/outcome/` read's online-only contract.

`demo_list` in the read is the server projection of `shipped[]` where
`demo_ready=True` (a server fact, MCP-reachable — the client does not derive it).

### §3 — Shareability: no new mechanism

The existing `/outcome/` read **already** satisfies "read-only shareable to the PM
without exposing velocity": it is `GET` (read-only), gated `IsProjectMember`
(Sarah/ADMIN is a member), and ADR-0104 nulls the velocity block + point fields
for her band. The new `accepted_points`/`not_accepted_points` join that
suppression. **No share-link, no new endpoint, no new role** — adding one would
duplicate the ADR-0104 gate and risk a second, drifting privacy boundary
(explicitly rejected in ADR-0104 Alternative E). Confirmed: nothing to build here.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A (chosen): `demo_ready` on `SprintTaskOutcome`; acceptance computed live; new `review` block on `/outcome/`** | Sprint-scoped + survives retention; rows exist at ceremony time; acceptance reflects in-review ticks; additive (no existing field touched); reuses the ADR-0104 gate | A mutable flag on a close-immutable audit row (documented exception); demo curation only after close |
| B: `demo_ready` boolean on `Task` | One field, available pre-close | Not sprint-scoped — leaks across sprints; "demo-worthy" isn't a task-intrinsic property; pollutes the Task model |
| C: snapshot acceptance state into `SprintTaskOutcome` at close | Immutable, point-in-time | Wrong — acceptance is *ticked during the review*, after close; a frozen-at-close acceptance count would always read 0 and defeat the ceremony |
| D: new share-link endpoint for the PM | Explicit "share" UX | Duplicates the ADR-0104 gate; second privacy boundary to keep in sync (ADR-0104 Alt E, rejected); the PM is already a member who can read |
| E: aggregate acceptance only over `disposition=completed` | "Accepted = of what shipped" | Hides committed-but-not-shipped stories the PO must still rule on; the three-bucket over the full membership is the honest ceremony view |

## Consequences

- **Easier**: the PO runs a real acceptance ceremony — accepted/not-accepted with
  coverage gaps visible — and curates a demo list, all on the existing review
  surface; the PM reads it safely (counts yes, velocity/points no); every value is
  a server fact (MCP-reachable, offline-N/A by design).
- **Harder**: a mutable `demo_ready` on an otherwise-immutable snapshot row (kept
  honest by a docstring + the close-snapshot fields staying immutable); acceptance
  aggregation is a live join (`SprintTaskOutcome → task → acceptance_criteria`) —
  bounded by sprint size, prefetched to avoid N+1.
- **Risks**: (1) a hard-deleted task in a closed sprint has no criteria → counted
  `no_criteria` (logged, not crashed); (2) forgetting to gate the new point fields
  re-leaks velocity — mitigated by routing them through the *same*
  `velocity_readable` flag + a regression test asserting the PM band sees null
  points but real counts; (3) migration `0070` collides with in-flight #851/#1106
  — renumber whichever merges last.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations. **OSS.**
- **Affected packages**: api (`demo_ready` field + migration; `toggle-demo` write
  path; `review` block in `sprint_outcome_payload` + `SprintOutcomeSerializer`;
  acceptance aggregation helper with prefetch); web (extend `SprintClosedOutcome`
  with an accepted-vs-not card + a shipped-stories list carrying acceptance badges
  and a per-story demo toggle + the demo-list grouping; `useSprintOutcome` already
  fetches the read; a `useToggleDemo` mutation). No scheduler change. Mobile: the
  review is an online read (ADR-0176) — `demo_ready` is online-only like the rest.
- **Migration required**: **yes** — one additive `BooleanField(default=False)` on
  `SprintTaskOutcome`; no backfill (existing rows default False = "not in the demo
  list", correct). `makemigrations` (next projects number **0070**; renumber if
  #851/#1106 merge first).
- **API changes**: yes — additive `review` block on the existing `/outcome/`
  response (no field removed → no schema-drift "removed" regression) + the new
  `toggle-demo` write route. Regenerate `docs/api/openapi.json` after merging
  origin/main.
- **OSS or Enterprise**: **OSS.**
- **Coordinate with**: ADR-0176 (the foundation this extends), ADR-0104 (the
  velocity/point gate the new point fields reuse — do not add a second gate),
  ADR-0105 (`AcceptanceCriterion`, the accepted-vs-not basis), #851 retro board
  (whose review surface shares the closed-sprint workspace) — and the migration-
  0070 three-way collision.

### Durable Execution
1. **Broker-down behaviour**: N/A — no async work. Acceptance aggregation is a
   synchronous read; the demo toggle is a synchronous field update whose only side
   effect is a best-effort `broadcast_board_event` on commit (the established
   board-event model). A dropped broadcast self-heals: the next `/outcome/` fetch
   carries the current `demo_ready`.
2. **Drain task**: N/A — no new async category; no Celery task added.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: `sprint_outcome_payload()` gains the `review` block
   (acceptance aggregation + `shipped`/`demo_list`); a new
   `toggle_demo_ready(outcome, value)` owns the field write + the on-commit
   broadcast.
5. **API response on best-effort dispatch**: synchronous — the toggle returns the
   updated `SprintTaskOutcome` (200); the broadcast is fire-and-forget on commit.
6. **Outbox cleanup**: N/A — no outbox rows created.
7. **Idempotency**: the demo toggle is idempotent by construction — it sets a
   boolean to the requested value (`PUT`-like); a replay sets the same value and
   re-broadcasts harmlessly. Acceptance aggregation is a pure read.
8. **Dead-letter / failure handling**: N/A for the synchronous write; a failed
   broadcast is dropped by design and recovered on the next read (documented
   board-event behaviour). No DLQ.
