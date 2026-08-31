# ADR-0325: A milestone is one canonical coupled state, not three independent signals

## Status
Accepted

> Resolves issue #1773 (2026-07-09 full-application audit, domain-model track).
> **ADR number:** `0325` was reserved for this worktree by the `wt` harness.

## Context

Three columns on `Task` each independently encoded "this is a milestone", and
nothing kept them in agreement:

- `is_milestone` (boolean) — set by the PM or preserved on MS Project / P6 import.
- `delivery_mode = 'milestone'` (one of the `DeliveryMode` choices, ADR-0036).
- `duration = 0` — the zero-length-gate convention.

Different consumers keyed off different signals:

- The phase percent/weight **rollup SQL** (`views.py`) weights a child at `0`
  only when `delivery_mode = 'milestone'`.
- **Sprint targeting** (`Sprint.target_milestone`), the milestone rollup
  (`recompute_milestone_rollup`), and milestone listing key off `is_milestone`.
- The **CPM boundary** (`scheduling/services.py`) re-derives a zero duration from
  `is_milestone`, ignoring `delivery_mode` and the stored `duration`.
- The **MS Project importer** wrote `is_milestone` and a raw `duration` via
  `bulk_create` and never set `delivery_mode`, so every imported milestone had
  `is_milestone = True` but `delivery_mode = 'waterfall'`.

The result was a task that reads as a milestone on one surface and an ordinary
task on another. The serializer only ever enforced a one-way clamp
(`is_milestone → duration = 0`), and `bulk_create` bypassed even that. The model
docstring compounded the confusion by asserting `duration = 0` was *not* the
canonical signal while the runtime (serializer clamp + CPM boundary) treated it
as exactly that.

Two related holes made the divergence worse: a milestone could acquire children
(nothing blocked create-with-parent / indent / reparent under it), and a
milestone that a live sprint targeted could be silently un-flagged, leaving the
sprint's `target_milestone` FK dangling and its rollup vanishing.

## Decision

**A milestone is a single canonical state: `is_milestone = True` iff
`delivery_mode = 'milestone'` iff `duration = 0`.** Every write path normalizes
to it rather than trusting one field.

1. **Couple the signals in `TaskSerializer.validate()`.** Whichever of
   `is_milestone` / `delivery_mode` the caller sends is authoritative and the
   other is synced to match; the effective milestone state then forces
   `duration = 0`. Sending both with conflicting values (e.g.
   `is_milestone = True` with `delivery_mode = 'scrum'`) is rejected with the
   stable field code `milestone_signal_conflict`. Un-flagging drops
   `delivery_mode` back to the `WATERFALL` default.

2. **Couple the same state in every non-serializer mint path.** The MS Project
   importer writes a `<Milestone>` task with `duration = 0` and
   `delivery_mode = 'milestone'` (a later PATCH no longer silently re-zeros a
   non-zero imported duration and shifts dates). The remaining ORM-direct mints
   that `bulk_create`/`create` past the serializer are coupled the same way:
   sprint-to-milestone promotion (`_create_milestone_for_sprint`), recurring-task
   occurrence spawn (copies the template's `delivery_mode`), the template/seed
   importer, and the demo seed command. Only then is the "the DB can only hold the
   coupled state" claim actually true — a sprint-promoted milestone in particular
   is exactly the sprint-targeted case the phase rollup weights on `delivery_mode`.

3. **A milestone cannot acquire children.** `perform_create` (create-with-parent),
   `TaskIndentView`, and `TaskReparentView` reject a move that would place a task
   under a milestone, with code `child_of_milestone`.

4. **A sprint-targeted milestone cannot be un-flagged.** Removing the milestone
   flag (directly, or by flipping `delivery_mode` off `'milestone'`) while a live
   `Sprint.target_milestone` references the task is rejected with code
   `milestone_targeted_by_sprint` — mirroring the existing `milestone_rollup_locked`
   percent-lock pattern (ADR-0074). Unlink or close the sprint first.

### Why couple rather than collapse to one field

Collapsing `is_milestone` and `delivery_mode='milestone'` into a single column is
the cleaner long-term model, but it is a breaking schema change that touches the
rollup SQL, the CPM boundary, sprint targeting, the importer/exporter, the sync
serializers, and every enterprise consumer registered against these fields.
Coupling at the write boundary closes the correctness hole now, before beta,
with no migration and no change to the read-side contract. A future collapse
remains open and is out of scope here.

### Chosen duration invariant

`duration = 0` for milestones — the state the serializer already clamped to and
the CPM boundary already forced. The model docstring, which previously claimed a
milestone could carry a non-zero duration, is corrected to state the coupled
invariant.

### Amendment (2026-08-31, #3265) — the invariant is enforced upward too

**As originally written, decision 1 was one-directional and the "the DB can only
hold the coupled state" claim in Consequences was false.**
`_reconcile_milestone_signals` reconciles the two *flags* against each other, and
the resulting milestone state then forces `duration = 0`. Nothing inferred the
flags from a bare duration. So `PATCH {"duration": 0}` on a work row landed
`is_milestone=False`, `delivery_mode != 'milestone'`, `duration=0` — precisely the
state this ADR says cannot exist — and every consumer that keys on `is_milestone`
(the outline glyph and date treatment, `outlineDrag`'s gate refusals, the Board,
CPM, sprint rollup) read it as work with no duration.

The hole was found because a client fell into it (#3256: "Convert to milestone"
sent a bare `duration: 0` and produced a zero-duration task while announcing a
milestone), but it was open to every caller — the MCP write tools, the MS Project
and CSV importers, `tasks/bulk/`, and any integrator against the documented v1 API.

**Option (b) is adopted, but narrower than the issue proposed, because the "iff"
as written is contradicted by the product and not only by the client bug.**

Implementing the literal rule first and testing it against a live request is what
surfaced this: refusing *every* zero on a non-milestone row returns 400 on two
deliberate, shipped Board paths.

- `BoardView.handleQuickCaptureBacklog` mints an intake idea at `duration: 0`,
  because it is *not scheduled work yet*.
- `BoardView.handleAddPhase` mints a container at `duration: 0`, because a phase's
  duration rolls up from its children.

Both are legitimately zero-duration and legitimately not milestones. So the
invariant the read-side consumers actually depend on is **not** "no zero-duration
non-milestone row may exist". It is the one #3256 broke: **a write must not take
an estimate away without saying what the row became.**

Option (a) — leave it aspirational, enforce nothing — was still rejected: that
leaves the hole open to the MCP write tools, `tasks/bulk/`, and any integrator
against the documented v1 API, which is what the issue was filed about.

**Refuse rather than infer**, with the stable code `zero_duration_not_milestone`.
Inference is friendlier to importers and is the wrong trade here: the client bug
that surfaced this was a caller that sent `duration: 0` and did *not* mean "make
this a gate". Inferring would have converted that bug into a silent data change
instead of a loud refusal — the same failure one level down.

| Write | Answer | Why |
|---|---|---|
| A write that zeroes a **currently non-zero** duration, on a row not becoming a milestone | **Refuse**, `zero_duration_not_milestone` | The #3256 shape exactly: an estimate destroyed with nothing said about what the row became. The message names the payload that does work (`is_milestone=true`). |
| A create at `duration: 0` | **Allow** | Nothing is destroyed. This is Board intake and Add phase. |
| A write of `duration: 0` to a row already at 0 | **Allow** | Re-asserting an existing zero destroys nothing. |
| Un-flag a milestone, **no** `duration` sent | **Default to the model default (1)** | The caller asserted "no longer a milestone" and asserted nothing about the estimate. The stored 0 is the gate's; leaving it lands a former gate masquerading as unestimated work, and refusing would make un-flagging impossible without guessing a number. |
| Un-flag a milestone **with** `duration: 0` | **Allow** | The stored duration was already 0, so nothing is destroyed. The result is an unestimated work row — the same legal state Board intake mints. |

**A zero-duration non-milestone row therefore remains legal**, and this ADR's
"iff" should be read as the coupling the *milestone flags* enforce, not as a
prohibition on unestimated rows. That is a correction to this ADR's original
wording, not a carve-out from it.

**Serializer-level validation, deliberately not a database constraint.**
`AddConstraint` builds and *validates* its index against every existing row, and
migrations run on container start, so a single legacy zero-duration work row would
be an upgrade crash-loop rather than a failed deploy. The guard fires only when a
caller *writes* a zero in this request, so existing rows stay readable and
editable — a `PATCH {"name": …}` on one still succeeds.

**Write-path denominator: 9 examined, 2 affected and covered, 1 examined and deliberately exempt.**

| Path | Status |
|---|---|
| `TaskViewSet` create / update (`POST`/`PATCH /tasks/`) | **Affected** — goes through `TaskSerializer.validate`, now guarded |
| `POST /projects/{pk}/tasks/bulk/` | **Affected** — `task_bulk._apply_create` and `_apply_update` both route through `TaskSerializer`, so it inherits the guard. Asserted rather than assumed: this endpoint has been a repeat site for this class (#3030, #3036), and rows apply independently, so a refusal lands in `rejected` and the legal rows still apply |
| MS Project importer | Not affected — `bulk_create`s past the serializer and already writes `duration=0 if is_milestone else …` with `delivery_mode` (decision 2) |
| Board intake / Add phase (`POST /tasks/` with `duration: 0`) | **Examined and deliberately left working** — creates destroy no estimate. The first draft of this change 400'd both; that is what narrowed the rule |
| Template / seed importer | Not affected — same coupling at the mint |
| `bundled_templates` | Not affected — same coupling at the mint |
| Sprint→milestone promotion (`_create_milestone_for_sprint`) | Not affected — mints the fully coupled state |
| Recurring-occurrence spawn | Not affected — copies the template's `delivery_mode` |
| `TaskIndentView` / `TaskReparentView` | Out of scope — neither writes `duration` |

## Consequences

- The database can no longer hold a "half-milestone"; rollup, CPM, and sprint
  code now agree on every task. **The `duration = 0` half of the "iff" was never
  enforced upward and, per the 2026-08-31 amendment, deliberately still is not** —
  a zero-duration non-milestone row is legal (Board intake, an empty phase). What
  the amendment closes is the *destructive* direction: a write that removes an
  existing estimate without declaring the row a milestone.
- Three new stable, MCP/agent-reachable rejection codes:
  `milestone_signal_conflict`, `milestone_targeted_by_sprint`,
  `child_of_milestone`. A fourth, `zero_duration_not_milestone`, is added by the
  2026-08-31 amendment above.
- No schema migration (the change is validation + a docstring, not a field).
- Enterprise code that reads `delivery_mode` or `is_milestone` continues to work
  unchanged; the two are now guaranteed consistent.
- A future single-field collapse is still possible and is deliberately deferred.
