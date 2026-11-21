# ADR-0136: Completed Tasks Retain Their Full-Duration Span

## Status
Accepted — refines ADR-0132 (Data-Date-Aware Forecasting) and amends ADR-0023
(Actual Start and Finish Dates on Tasks) — implemented on main; status corrected 2026-06-30 after ADR audit (verified: ADR-0136)

> **Amended 2026-10-11 (#4343): a completed task with no actuals is pinned, not
> network-placed.** The "neither" row and the "No actuals → network position" rule below
> originally placed such a task through its FS/SS predecessors. Only the forward pass did
> that: the backward pass, free float, Monte Carlo and the derivation all treated the same
> task as out of the network, as "Symmetry & float" says every completed task is. The two
> halves of the engine therefore disagreed about one task, and every predecessor inherited
> it — float measured against a successor that never constrained it, a false critical path,
> Monte Carlo freezing a position that in fact moved with its predecessors, and a derivation
> citing a predecessor's date as the project start. The forward pass now pins it too, in
> both engines (`engine.py::_pinned_placement`, `forward.rs::pinned_placement`) and the
> browser drag preview (`cpmEngine.ts`). A completed milestone with no actuals keeps its
> instant semantics (see Rules). The table and rules below are updated in place; the Monte
> Carlo follow-up is resolved.

> **Amended 2026-11-16 (#4883): a floored milestone's link instant is monotone.** A
> milestone held by a floor links from the latest of its link and the close of the last
> working day before the floor, so slipping a predecessor never moves its successors
> earlier (for an SNET, data date or actual_start floor; the project-start floor is
> excluded, #5055). This changes live schedules: a wider-calendar successor of a Monday-floored
> milestone can sit on the weekend before it. See the dated bullet under Decision → Rules.

> **Amended 2026-11-21 (#5017): the sign-off pin is authoritative.** A milestone closed
> with recorded actuals sits at the end of its recorded day exactly when the caller hands
> back `live_day_end_on` naming that day, and at the start otherwise; no predecessor is
> read for the edge. This supersedes the completed-predecessor reading (#4525) and its
> recorded-day cap (#4703), which were not monotone. One predecessor read remains, as an
> owner-accepted exception: a calendar-day lag out of a milestone closed at the start of
> its day can count from an earlier equivalent midnight read from completed predecessors
> (#4690), so successors can move later, never earlier; a pin-only link instant is #5089.
> See the dated bullet under Decision → Rules.

> **The conformance-fixture constraint below is superseded by shipped practice** (verified
> 2026-07-31, #2664). Both the Constraints section ("the shared `wasm:conformance` fixtures
> carry **no** progress fields and must stay that way — adding actuals/`status_date` to the
> shared set would diverge the engines and redden the gate") and the matching line under
> Consequences describe a rule the repository no longer follows.
>
> `packages/wasm-scheduler/fixtures/` now carries seven `progress_*.json` fixtures, and they
> contain exactly the fields the constraint forbids: `percent_complete`, `actual_start`, and
> `actual_finish` (e.g. `progress_completed_successor_no_backward_constraint.json`), plus a
> project-level `status_date` (`progress_status_date_floor.json`). The engines did not
> diverge and the gate is green, because the Rust engine gained the progress path after this
> ADR was written.
>
> Adding further progress fixtures is therefore consistent with current practice, not a
> violation. Note the separate, still-true caveat that `wasm:conformance` compares the two
> engines to **each other**, so it cannot detect a divergence they *share* from a written
> spec — a fixture asserting a spec rule must be written from the ADR text, not from the
> sibling engine's output.

## Context

**P3M layer:** Programs and Projects (OSS). This is core scheduling-engine IP and
touches only single-project CPM; no cross-project or portfolio aggregation.

A task marked 100 % complete collapses to a **one-day bar** in the schedule grid
(Start == Finish) while the Duration column keeps the original value (a 5d task
shows `Dur = 5d` but `Start == Finish`). This is a user-visible correctness bug:
completed work loses its span.

### Root cause — two coupled defects

The progress-aware CPM forward pass introduced by ADR-0132 (#1186) collapses any task
whose `percent_complete == 100` but whose `actual_finish` is `None`:

1. **Engine 0-remaining path.** `_effective_duration_days()` returns
   `duration − floor(duration × pct/100)` = **0** for a 100 % task
   (`packages/scheduler/src/trueppm_scheduler/engine.py:332`). The forward pass only
   pins a completed task when `actual_finish is not None` (`engine.py:566`); a 100 %
   task without it falls through with 0 remaining duration, and
   `_finish_from_start(start, 0)` returns `start` (`engine.py:292`) → Start == Finish.
   The backward pass has the identical gap (`engine.py:649`), so late dates collapse
   too and the task is mis-flagged critical (float 0).

2. **Write path forces fake actuals.** On the `COMPLETE` transition, the serializer
   sets **both** `actual_start` and `actual_finish` to `today` when the task has no
   prior start (`projects/serializers.py:2127-2131`). A task taken straight to done
   without ever being `IN_PROGRESS` therefore pins to `today → today` — a one-day bar
   parked at the wrong place. This means the engine fix alone is insufficient: the
   engine *trusts two present actuals*, so `[today, today]` would re-collapse the span.

### How the bad state is reached (all three are real)

- **Seed fixtures** — 58 of 58 completed tasks across the four sample projects carry
  `actual_start: null, actual_finish: null` (this is the data in the bug screenshot).
- **Contributor completion** — marking 100 % as a non-admin auto-promotes to `REVIEW`,
  which sets `actual_start = today` but never `actual_finish`
  (`serializers.py:2119-2125`).
- **Direct completion without a recorded start** — the `[today, today]` case above.

### Constraints this fix must respect

- **The scheduler package has zero Django dependencies** (`models.py`/`engine.py` see
  only the dataclass `Task`, which has `percent_complete`, `actual_start`,
  `actual_finish` — **not** `status`). Completion must be detected from
  `percent_complete`/`actual_finish`, never `status`.
- **Python ↔ Rust conformance** (ADR-0015). The Rust/WASM engine ignores
  `percent_complete`/`actual_finish` and always uses full duration with no
  `status_date` floor. Per ADR-0132's staging (#1187, 0.4) the shared
  `wasm:conformance` fixtures carry **no** progress fields and must stay that way —
  adding actuals/`status_date` to the shared set would diverge the engines and redden
  the gate.
- **`actual_start` and `planned_start` are independent** (ADR-0023); never conflate.
- **CPM `bulk_update` bypasses `VersionedModel.save()`** (ADR-0091); no
  `server_version` bump on CPM-output fields.

## Decision

A task is **effectively complete** in the engine when
`percent_complete >= 100` **or** `actual_finish is not None`. (In practice these are
equivalent: `Task.save()` coerces `REVIEW`/`COMPLETE → percent_complete = 100` and the
serializer coerces `percent_complete = 100 → REVIEW`/`COMPLETE`.) An effectively-complete
task is **always laid out with its full working-day duration** — it never takes the
0-remaining path — and its span is anchored to whatever actuals exist:

| Actuals present | Early start | Early finish |
|---|---|---|
| both | `actual_start` | `actual_finish` *(actuals are truth, even if span ≠ duration)* |
| only `actual_finish` | `actual_finish − full_duration` (working days back) | `actual_finish` |
| only `actual_start` | `actual_start` | `actual_start + full_duration` |
| neither | `max(project start, planned_start)` — no predecessor constraint, **not** floored at `status_date` *(#4343)* | `early_start + full_duration` |

Rules:

- **Full duration, not remaining.** A completed task contributes its full estimate, so
  the bar keeps its shape. (Remaining-duration scaling stays as ADR-0132 defines it for
  *in-progress* tasks — that path is unchanged.)
- **Derive the missing endpoint.** When exactly one actual is recorded, the other is
  derived from full working-day duration via the existing
  `_start_from_finish`/`_finish_from_start` helpers.
- **No actuals → pinned at the project start or its SNET, capped at the data date.** A completed task
  with no actuals is pinned like every other completed task: its full duration is laid
  out from the project start (snapped to the task's calendar), or from its
  `planned_start` when that is later. No predecessor link of any type moves it — the work
  is done, so nothing upstream can delay it — and it is **not** floored at the data date,
  because completed work is historical. *Amendment (#4539):* it is capped at the data
  date: when the laid-out span would finish after it, the task is laid back to finish
  on the data date (the working day before it when that is not a working day), keeping
  its full duration, so that recording no actuals never slips the schedule further than
  recording an `actual_finish` on the data date would. A data date at or before the
  project start caps nothing. The Python engine, the Monte Carlo index and the Rust/WASM
  engine all apply it; the in-browser drag preview does not yet mirror it, so a
  100%-complete task with no actuals dropped past the data date previews uncapped until
  the server reconciles. (Superseded rule, before #4343: "positioned by its
  FS/SS predecessor constraints, `planned_start`, and project start". The forward pass
  applied it while the backward pass did not, which is the defect #4343 fixed.)
- **A completed milestone with no actuals stays an instant.** Pinning takes a
  zero-duration task out of the network, not out of being a milestone: it is an instant
  at the **start** of its pinned day, exactly what a live milestone with no links gets,
  so an FS successor starts that same day and nothing downstream moves relative to the
  live case (#4343). Its `planned_start` binds the instant its successors measure from;
  the project start only bounds where it is shown (#4225).
- **A completed milestone with recorded actuals stays an instant too, and keeps its live
  edge (#4433).** The instant is on its `actual_finish` day, else its `actual_start`
  day, and it is both shown and linked from — actuals are truth, so a `planned_start`
  no longer binds. Which edge of that day it sits on is the edge it had live: its
  predecessor links compete with the recorded day as a start-of-day floor, exactly as
  the data date or an SNET would have, so it sits at the **end** of the day
  (`milestone_at_day_end` True) only when work finishing that day placed
  it, and at the **start** when no work precedes it or a floor held it. (Amended
  2026-11-09, #4703, and superseded 2026-11-21 by #5017 below: this read "that day (or later)". Work recorded as finishing
  after the sign-off — out of sequence — reached past the end of the recorded day
  and read as end-of-day, so closing it slipped an already-closed milestone's
  successors a working day. A link proposal shown on a later day than the recorded
  one is now dropped from the reading, in both engines, and while one is, a
  handed-back `live_day_end_on` edge stands as it does for open work: dropping the
  proposal alone pulled the successors a working day *earlier* on the API path,
  where that edge is handed back. The rule reads the day a link places the
  milestone, not the day the work finished, so FS-1d from work finishing the day
  after the sign-off still gives the end of the day. Known limits, tracked in #4915: a faithful end-of-day hand-back is re-read from the completed work when a closed late predecessor's link places the milestone at or before its day, so successors can move a working day earlier; and several late predecessors with negative lag can drop one late proposal and let another through, so successors move a working day later. A gate at the start of its day has no hand-back value to stand on.) Closing a
  milestone on the day it was forecast therefore moves nothing downstream. (Decided
  2026-10-16, "preserve the live edge": an earlier draft put every closed milestone
  at the start of its day, which pulled a successor of a milestone that follows work
  into the day that work was still finishing; a later one read the edge off the links
  alone, which put a milestone held by the data date or an SNET at the end of its day
  and slipped its successors again.) (Superseded rule, before #4433: "A milestone pinned by recorded actuals is
  unchanged: it is laid out as ordinary work, ending at the end of its day." Because
  `COMPLETE` stamps `actual_finish`, that rule made closing a milestone slip every FS
  successor, and the project finish, a working day later than the same milestone live
  or completed without actuals.)
- **Only completed predecessors decide that edge (amended 2026-10-18, #4525; superseded
  2026-11-21 by #5017, "the sign-off pin is authoritative", below).** As first
  shipped, the #4433 rule read every predecessor's *current* forecast, so a milestone
  signed off while a predecessor was still open had its edge re-derived on every
  reschedule: an open predecessor slipping a day flipped the edge, its successors moved a
  working day either way, a longer predecessor could finish the project earlier on an
  FS-only network, and the predecessor's float — measured by a backward pass that skips
  completed successors — ignored the coupling. The edge is now read from completed
  predecessors only. Those are pinned themselves, so nothing live can move a closed
  milestone, date or edge. Reading completed predecessors alone would still have moved
  successors when a milestone was signed off before its work was marked done (start of
  day), then back when the work was completed (end of day). So the edge is also frozen
  from the one fact recorded about open work: the input `Task.live_day_end_on`, the
  day the caller's previous run showed the milestone at the end of. While any
  predecessor is still open and it names the recorded day, the milestone stays at the
  end of it. A different day (signed off later than forecast) does not carry, and
  once every predecessor is complete the completed-predecessors reading decides
  again — the freeze stands in for facts open work has not supplied, so it must not
  outlive them: a corrected predecessor actual or a deleted link is re-read. The API passes its
  persisted `early_finish` / `milestone_at_day_end` back as that input. A caller that
  passes nothing gets the completed-predecessors reading. (Decided 2026-10-18,
  "freeze the edge at close": it keeps both #4433's "closing on the forecast day moves
  nothing" and the invariant that open work never moves a completed task. Rejected:
  honoring the bare `milestone_at_day_end` flag — it cannot tell a sign-off on the
  forecast day from a later one, which would bring #4433 back.)
  - *The persisted day is the sign-off day.* A closed milestone that passed through
    In Progress carries an `actual_start` earlier than its `actual_finish`. The engine
    reports that pair as its pinned window (`early_start = actual_start`,
    `early_finish = actual_finish`) but places the instant on `actual_finish`. The API
    writeback collapses every milestone row to one day, and used to collapse onto
    `early_start`, so the day handed back as `live_day_end_on` was `actual_start`. It
    never matched the recorded day, so the freeze released on the second
    recalculation after close and the successors moved with nobody changing anything.
    The writeback now collapses onto `early_finish`, the day the engine places the
    instant on. (Decided 2026-10-18. Rejected: reporting `actual_finish` as the
    engine's own `early_start` for a closed milestone, which would change engine
    output and derivation provenance for every library caller to fix one API
    persistence step. Also rejected: having `build_sched_tasks` hand back
    `actual_finish or actual_start` for a closed milestone flagged at day end. That
    reads the *current* actuals, so after a correction to `actual_finish` it would
    carry the old day's edge onto the new day, which is the #4433 bug.) A side effect
    is that such a milestone's row now shows its sign-off day rather than the day it
    entered In Progress. That matches where the engine places it and where its
    successors are measured from.
  - *Upgrade.* The first recalculation after upgrading reads whatever the previous
    version persisted. For a closed milestone whose predecessor is still open, that
    is the previous version's edge, including one the pre-#4525 rule derived from
    open work. A milestone persisted under the old `actual_start` collapse is
    re-read from completed predecessors once and then stays put. Either way the
    successors can move one working day once. Neither repeats, and once every
    predecessor is complete, completed work decides. The upgrade notes say so.
  - *Known limitation: the freeze depends on history while a predecessor stays
    open* (#4574). While any predecessor is still open, the frozen edge is whatever
    was last derived. It does not necessarily match the current state of the
    completed predecessors and links. Correcting a completed predecessor's actuals,
    or removing a predecessor link, does not trigger a fresh derivation until every
    remaining predecessor completes. So the same current facts can schedule
    differently depending on what happened before. A run with no history reads the
    corrected facts, while a run that froze the edge earlier keeps it. And once a
    corrected sign-off day has replaced the persisted day, correcting it back does
    not restore the original edge. This is a limitation of freezing itself, not a
    defect in this rule: the guarantee that no change to open work moves a closed
    milestone still holds. Making the edge path-independent while keeping "closing
    on the forecast day moves nothing" is left to #4574.
  - *Amended 2026-11-21 (#5017): the sign-off pin is authoritative.* Reading the
    edge from where completed predecessors' links placed the milestone (#4525),
    capped at the recorded day (#4703), was not monotone. `A(1d, closed) -FS-> M`
    (signed off Wed) `-FS+1d-> B`: with `A.actual_finish` on Mon, Tue, Thu or Fri
    the milestone sat at the start of Wednesday and `B` started Thursday; with it
    on Wednesday alone the end of Wednesday won and `B` started Friday. Recording a
    *later* finish (Thursday) pulled `B` a working day earlier and the project
    finish three calendar days earlier. The same reading let a lag edit on an
    unrelated completed link flip the edge with no date moving (the audit's
    CPMF-3). Option 1 in the issue (end of day whenever any completed predecessor
    finishes at or after the sign-off day) restored monotonicity but still made
    `B` depend on `A`; option 2 (document the non-monotonicity) left a forecast
    that improves when work is recorded later. **Rule (owner decision,
    2026-11-21):** a milestone closed with recorded actuals sits at the **end** of
    its recorded day exactly when `Task.live_day_end_on` names that day, and at
    the **start** of it otherwise. No predecessor is read for the edge — not its
    actuals, link type, lag or calendar, and not whether it is open — so every row
    of the table gives the same `B`, and raising a lag on a completed link never
    flips the flag. (The table's `B` is a zero-lag reading of the edge; see the
    accepted exception below for a lag out of a milestone at the start of its day.) This also removes #4574's path dependence: the edge is a
    function of the milestone's own fields, so the same facts always schedule the
    same way; and the freeze/release machinery (`_completed_after_recorded`, the
    open-predecessor freeze, the completed-work re-read) is gone, because the
    hand-back is never re-read. The cost: a caller that does not hand back
    `live_day_end_on` gets the start of the recorded day, so for such a caller,
    closing a milestone that work finishing that day had placed at the end of it
    moves its FS successors a working day earlier (#4433's case). The API hands it
    back on every run, so its path keeps "closing on the forecast day moves
    nothing". A correction to completed work no longer releases a handed-back
    end-of-day edge; to release it, the caller stops handing it back (or the
    milestone is re-signed on another day). **Scope of the link instant:** the
    milestone's *link* instant at the start of its day (#4690, below) still reads
    completed predecessors, but only to choose which midnight equivalent to the
    pinned day's start a calendar-day lag counts from (the recorded day's start or
    the non-working run before it). That choice is non-decreasing in every
    proposal and a proposal after the recorded day leaves the recorded day's
    start, so a later predecessor finish never moves a successor earlier; the
    working-time point is the pin's. #4740 (closing ahead of open work) is that
    reading's open residual and is unchanged. **Accepted exception (owner
    decision, 2026-11-21):** because of this reading, the edge is the pin but a
    lagged successor is not a function of the pin alone. `A(1d)` closed Fri
    2026-03-06 `-FS+lag->` `M` closed Mon 2026-03-09 (no hand-back) `-FS+2d->`
    `B(1d)`: with lag 0, `M` links from Sat 00:00 and `B` starts Mon 03-09; with
    lag 1, from Sun 00:00 and `B` starts Tue 03-10; with `A` closed on Mon, from
    Mon 00:00 and `B` starts Wed 03-11. So a correction to completed work or a lag
    edit on a completed link *can* move such a successor, later and never earlier.
    The owner kept this rather than widen #5017 into the link instant; a pin-only
    link instant (the lag counts from the pin's own midnight, whatever the
    predecessors) is tracked as #5089. Pinned by
    `TestClosedMilestoneEdgeIsThePin::test_accepted_exception_*` and the
    `progress_closed_milestone_link_instant_exception` conformance fixture.
    **Importers:** the hand-back is the only source of the end-of-day edge, so a
    schedule imported with a milestone already closed on the day its completed
    work finished needs `live_day_end_on` seeded at import, or its FS successors
    land a working day earlier than in the source file. The MS Project importer
    seeds it (`milestone_at_day_end` with `early_finish` on the recorded day,
    which the API hands back as `live_day_end_on`) when a completed milestone's
    `<ActualFinish>` time of day is at or after the end of its working day: the
    latest `<ToTime>` of that weekday's shifts in the milestone's calendar (the
    task's `<CalendarUID>`, else the project's), else the file's
    `<DefaultFinishTime>`, else 17:00. The calendar comes first because TruePPM's
    own exporter writes such a milestone at its calendar's shift end (16:00 on the
    8-hour default), which a 17:00 `<DefaultFinishTime>` would read as the start of
    the day; the exporter also writes `<DefaultFinishTime>` to match. The CSV and Jira importers and the `import_seed`
    command cannot: they import no actual dates at all, so no milestone arrives
    closed with actuals; there is no XER importer. Implemented in `_live_milestone_edge`
    (`engine/forward.py`), kept as the 0.4 import name, and `live_milestone_edge`
    (`wasm-scheduler/src/forward.rs`); pinned by the
    `progress_closed_milestone_edge_is_the_pin` conformance fixture, whose expected
    dates are hand-computed in its description, and by
    `TestClosedMilestoneEdgeIsThePin` (link type x lag x predecessor open/closed x
    project/task calendar x hand-back).
  - *Amended 2026-10-31 (#4690): the link instant, not only the edge.* A live
    milestone shown at the start of a day can link from an earlier midnight
    (Sunday 00:00 shown on Monday, #4173, or a point below the project start,
    #4225), and successors count calendar-day lag from it (#2534). A milestone
    closed at the start of its recorded day now re-reads that instant from its
    **completed** predecessors (`_closed_milestone_link`), the same facts the edge
    is read from, instead of linking from the recorded day's midnight. While any
    predecessor is still open it keeps the earlier rule and links from the
    recorded day, so closing it there can still move a lagged successor. That
    residual is #4740; #4574 covers only the edge freeze. A fact-free stand-in
    (link from the close of the working day before) was tried and dropped: it
    broke more open-predecessor cases than it fixed.
  - *Amended 2026-10-31 (#4690): floors that only tie a link.* For a live
    milestone, a floor (`actual_start`, `planned_start`, or the data date) that
    falls on, or snaps to, the day the latest link already shows the milestone at
    the start of no longer becomes the link instant; the link keeps its own
    midnight (`_equivalent_link`). This changes live schedules in one case: a data
    date on that day (a weekend data date snaps to the Monday) used to push the
    milestone's lagged successors later and now leaves them where the link put
    them. *Superseded in part 2026-11-16 (#4883), next bullet:* the tie was the
    only case that kept the link's own midnight, and that made the forward pass
    non-monotone.
  - *Amended 2026-11-16 (#4883): the link instant is monotone.* The tie rule
    above linked from the proposal's own midnight only when it tied the floor, and
    from the floor otherwise. On a Monday-to-Friday week with a Monday floor, a
    predecessor slipping from Thursday to Friday moved the latest link proposal
    from Saturday 00:00 read as the end of Friday (no tie, link = Monday 00:00) to
    Sunday 00:00 read as the start of Monday (tie, link = Sunday 00:00): the link
    instant jumped *back*, and every successor that can sit in the weekend gap (a
    wider calendar, or a calendar-day lag) moved earlier. Slipping a predecessor
    moved work earlier. This was confirmed for SS+1, FS+1 and FF+1 into the floored
    milestone, for weekend and Monday SNETs, and, through the nightly fuzz, against
    the data date and a live milestone's recorded `actual_start` (#4900, #4922,
    #4981). All three engines and the reference oracle agreed, so neither
    `wasm:conformance` nor the oracle could see it.

    **Rule.** A milestone held by a floor links from the latest of its latest
    link proposal and the floor's *earliest equivalent midnight*: the close of the
    last working day before the floor (Saturday 00:00 for a Monday floor on a
    Monday-to-Friday week), read as the start of a day. A floor on a non-working
    day — only a verbatim `actual_start` can be one, since an SNET or data date
    snaps to the next working day — is read the same way, back to the start of
    the non-working run that holds it: a Sunday `actual_start`'s earliest
    equivalent midnight is Saturday 00:00, as a Monday floor's is (fix round of
    2026-11-16, below). Every
    midnight from there to the floor is the same point in working time, so the
    floor still holds the milestone no earlier than it, and the successors still
    see a link instant at or before the floor. A proposal inside that window keeps
    its own midnight, as the tie rule had it, so recording or pinning the day a
    milestone is shown on still moves nothing. A proposal below the window now
    links from the window's start, not from the floor. That is the one choice
    that is non-decreasing in the proposal, so a slipping predecessor never moves
    the milestone's successors earlier. Unchanged: a floor with no non-working
    time before it (Tuesday to Friday on that week, and the first day of a
    non-working run, such as a Saturday `actual_start`) links from the floor; a
    floor on a non-working day is still *shown* verbatim on its own day; a
    proposal below the project start, when the floor is the
    project start's day, keeps its own instant (#4225); and a milestone with no
    predecessor links from its floor. Implemented as `_equivalent_link` and
    `_earliest_equivalent_midnight` (`engine/milestones.py`), mirrored in the
    Monte Carlo milestone reading (`engine/montecarlo/forward.py`), the Rust
    engine (`forward.rs::equivalent_link`) and the reference oracle
    (`tests/oracle/reference_cpm.py::_floor_link`). The repros, an explicit
    expected-date test, and a sweep of all four link types × lags −3..+2 × the
    four floors × same- and wider-calendar successors are pinned in
    `tests/test_cpm_oracle.py`. The strict-xfail repros from #4882 now pass, and
    the live slip property carves nothing out.

    **Consequences — this changes live schedules.** Every milestone held by a
    floor that follows non-working time (a working day, or a weekend
    `actual_start` after the first day of its run), with a predecessor
    whose link proposes an earlier instant, now links from that earlier midnight
    instead of from the floor:
    - *Fix round, 2026-11-16.* The rule as first written here treated a floor on
      a non-working day as having no earlier equivalent, so it linked from
      itself. That made the floor-to-link map go *backward* from Sunday to
      Monday: Saturday → Saturday, Sunday → Sunday, Monday → Saturday. Recording
      a live milestone's `actual_start` a day later, from Sunday to Monday, moved
      its successors earlier (`T1(1d) -FS-> M`, `M -FS-> S` and `M -FS+1d-> W`
      with `S`/`W` on seven days: a Sunday 01-18 `actual_start` put `S`/`W` on
      01-18/01-19, a Monday 01-19 one on 01-17/01-18). A non-working floor now
      reaches back to the start of its run, so Saturday, Sunday and Monday all
      link from Saturday 00:00 and the map is monotone. The consequence is the
      Monday one below, extended to Sunday: a Sunday `actual_start` on a
      Monday-to-Friday milestone with a predecessor proposing an earlier instant
      now links from Saturday 00:00, so a seven-day successor sits on that
      Saturday (it sat on the Sunday before #4883 and on the first pass of this
      amendment) and a calendar-day lag counts from Saturday, a day earlier than
      before. A Saturday `actual_start` is the start of its run and links from
      itself, as before. Pinned by a weekend-floor sweep (`actual_start`, SNET and
      data date on Friday to Tuesday × the four link types × lags −1..+1 × same-
      and wider-calendar successors), checked on Python and Rust for a later
      floor and a predecessor slip, plus the dates above as an explicit
      regression test.
    - A lag out of the milestone can count from before a recorded `actual_start`,
      and before the project start: a Monday `actual_start` that is also the
      project start's day links from Saturday 00:00 when its predecessor proposes
      an earlier instant. Four oracle-corpus entries changed for this
      (`named_control-below-start-SF-{FS,SS,FF,SF}-started`): an SF-linked
      milestone started on Monday 01-05, the project start, now links from
      Saturday 01-03, and its calendar-day-lagged successor `B` moved two calendar
      days earlier (01-08 → 01-06, 01-07 → 01-05).
    - A successor on a wider calendar can sit on the non-working days *before*
      the floored milestone's shown day: with a Monday SNET on a Monday-to-Friday
      milestone, its FS successor on a seven-day calendar now starts on the
      Saturday before, not on Monday. The issue's repro (`T1 -SS+1d-> T2`,
      Saturday SNET, `T2 -FS-> T4/T5` on seven days) puts `T4`/`T5` on Saturday
      01-10 for every slip up to Friday, where they were on Monday 01-12.
    - A calendar-day lag out of the milestone counts from that earlier midnight:
      `A -FS-> M -FS+2cd-> B` with `M` held at Monday puts `B` on Monday, not
      Wednesday. With the data date as the floor, that lag counts partly from
      before the data date; the successor is still held by its own data-date
      floor, so no work is scheduled in the past, but the lag is not "counted
      from now".
    - An SF-linked milestone placed at the close of the working day before its
      floor (#4635) gains nothing downstream from that floor.
    - A closed milestone's link re-read from its completed predecessors
      (`_closed_milestone_link`, above) follows the same rule, so it still
      matches the live milestone. Not changed: the open-predecessor residual
      (#4740), and the closed-milestone *edge* rule (#4703). In particular this
      amendment does not address #5017 (a closed predecessor finishing on a
      signed-off milestone's day flips its edge); a sign-off day directly after
      another working day has no earlier equivalent midnight, so #5017's repro
      schedules exactly as before.
    - Not covered by the monotonicity guarantee, and unchanged in kind: *adding*
      a predecessor to a floor-only milestone can move its successors earlier,
      because the milestone then links from the earliest equivalent midnight
      instead of from its floor. A link addition is not a slip. The tie rule
      already did this for a tying predecessor; the window is now wider.
    - Not covered either: the project-start floor. Moving the project start later
      can still move a floored milestone's successors earlier (#4225, #4635); this
      predates the amendment and is tracked in open issue #5055.
    - Not verified against MS Project or Primavera P6, which schedule in absolute
      time and do not model this choice.
- **Symmetry & float.** Applied identically in the backward pass: a completed task gets
  `late_finish = early_finish`, `late_start = early_start` → total float 0, and it
  **drives successors** from its resolved `early_start` (SS/SF) / `early_finish` (FS).
- **Negative float is reality, not error** (ADR-0132): an out-of-sequence actual may
  give a successor negative float; surface it, don't correct it.

### Write-path amendment (ADR-0023)

On the `COMPLETE` and `REVIEW` transitions, **stop auto-filling `actual_start = today`
when the task has no prior start.** Leave `actual_start` null and let the engine derive
the historical start from `actual_finish − full_duration` (COMPLETE) or position it via
network logic (REVIEW). A genuine `actual_start` recorded at `IN_PROGRESS` is still
preserved, and an explicit payload value still wins. `actual_finish = today` on COMPLETE
is unchanged. This removes the `[today, today]` collapse at the source and yields a
realistic span without inventing a start date.

> Capacity/EVM consumers that read `actual_start` must fall back to the engine's
> `early_start` when `actual_start` is null (the engine now supplies a realistic derived
> start). Verified clean under `regression-check` / `perf-check` before merge.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Full-duration span in engine + write-path amendment (chosen)** | Fixes all three sources; bar keeps its shape; single-sourced in the engine; no schema change | Touches core IP (forward + backward pass); amends an Accepted ADR |
| B. Engine fix only (treat pct≥100 as full duration), leave write path | Smaller diff | `[today, today]` straight-to-done tasks still collapse — engine trusts two actuals |
| C. Write-path / data fix only (always stamp realistic actuals), leave engine | No engine risk | Latent engine bug remains for imported/synced data with null actuals; doesn't fix the 0-remaining backward-pass float bug |
| D. Backfill `actual_start`/`actual_finish` into all 58 seed tasks, no engine change | Demo data looks right | Doesn't fix the product; every future completion re-triggers the bug |

## Consequences

**Easier**
- Completed tasks render with their true span everywhere CPM output drives the bar.
- One completion rule, single-sourced in the engine; the grid Duration column and the
  bar finally agree.

**Harder / risks**
- Core-engine change in both passes — must not regress not-started / in-progress paths
  (ADR-0132). Covered by Python unit tests plus the existing conformance suite (which
  carries no progress fields and stays byte-identical → green).
- Write-path change amends ADR-0023's "COMPLETE → actual_start = today" rule; any
  consumer assuming `actual_start` is non-null on a COMPLETE task must tolerate null and
  fall back to `early_start`. Audited in `regression-check`.
- Python ↔ Rust progress divergence remains as ADR-0132 already documented (#1187, 0.4).
  This ADR does **not** add progress fields to the shared conformance fixtures; the
  progress path is covered by Python-only tests. The server is authoritative (ADR-0015).

**Follow-ups**
- *Actuals span guard (done in this change).* Routing `actual_finish`/`actual_start`
  into the working-day walk added a new user-controlled input to a calendar scan. To
  match the existing far-future guards on `planned_start`/`status_date`/`planned_finish`
  (#951), `_validate_project` now rejects an `actual_*` more than `MAX_PROJECT_SPAN_DAYS`
  from the project start on both the CPM and Monte Carlo paths.
- *Monte Carlo treatment of undated-complete tasks — resolved.* Monte Carlo now pins
  every completed task at the dates `schedule()` gives it (`_completed_dates`, #2572), and
  since #4343 those dates do not depend on any predecessor, so the pin is the position
  every sampled run would compute. The original deferral, kept for the record: The deterministic pass
  treats `percent_complete >= 100` as complete; the MC sampler still pins only on
  `actual_finish`, so a REVIEW task (100%, no finish) or undated seed task is pinned in
  CPM but re-sampled in MC. After the write-path fix a COMPLETE task always carries
  `actual_finish`, so the gap only affects not-yet-signed-off REVIEW work and demo
  seeds. Aligning the MC sampler with `_is_complete` (and the Rust/WASM parity in #1187)
  is a separate, scoped change — filed as a follow-up, not bundled here.

**Seed data**
- With the engine fix, the "neither actual" branch already gives completed seed tasks a
  full-duration position (since #4343, pinned at the project start or their SNET), so the
  **bug screenshot is fixed by the engine alone**.
  Backfilling realistic `actual_start`/`actual_finish` into the seed builder scripts is
  desirable for demo fidelity (and exercises the both-/one-actual branches) but is not
  required for correctness; scoped as a follow-on within this change, deferrable if the
  builder-script churn is disproportionate.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: **scheduler** (forward + backward pass), **api** (serializer write
  path; optionally seed builder scripts), **web** (none — bar already reads CPM output)
- Migration required: **no** (`actual_start`/`actual_finish` exist since projects 0016;
  no schema change)
- API changes: behavioral only — `actual_start` is no longer auto-stamped to today on a
  COMPLETE/REVIEW transition that had no prior start; OpenAPI surface unchanged
- OSS or Enterprise: **OSS** (`trueppm-suite`); `grep -r trueppm_enterprise
  packages/scheduler packages/wasm-scheduler` → zero, unchanged

### Durable Execution
1. **Broker-down behaviour:** N/A — no new async work. Setting completion already
   triggers CPM recompute through the existing `scheduling/services.py::enqueue_recalculate()`
   outbox path (ADR-0027); this ADR only changes what that recompute *computes*.
2. **Drain task:** Reuses the existing CPM recalculation drain; semantics unchanged.
3. **Orphan window:** N/A — no new outbox rows.
4. **Service layer:** Existing `enqueue_recalculate()`; no new dispatch path.
5. **API response on best-effort dispatch:** Unchanged — task PATCH returns the updated
   task synchronously; CPM recompute is the existing async follow-up.
6. **Outbox cleanup:** N/A — no new outbox category.
7. **Idempotency:** The engine pass is a pure function of task inputs; recomputing twice
   yields identical CPM output. The write-path change is idempotent (a second COMPLETE
   PATCH leaves `actual_start` null and `actual_finish` set — no drift).
8. **Dead-letter / failure handling:** N/A — inherits the existing CPM recompute
   retry/DLQ behaviour (ADR-0017/0084); no new failure mode introduced.
