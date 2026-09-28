# Changelog

All notable changes to **trueppm-scheduler** are documented here.

This is the changelog for the standalone PyPI package only. The suite-wide
`CHANGELOG.md` at the monorepo root covers the API, web, and deployment
artifacts, which are not relevant to library consumers.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package is in the `0.x` series (`Development Status :: 4 - Beta` from
0.4.0b1), the public API — the `__all__` surface of `trueppm_scheduler` — may
change between releases. Pin an exact version (e.g.
`trueppm-scheduler==0.4.0b1`).

## [Unreleased]

### Added

- **`Task.milestone_at_day_end` (#4079).** `early_start == early_finish` names
  only the day a milestone is shown on; this new output field says which end of
  that day its instant is. `True` means the end of the day (the milestone follows
  work: `A(Mon..Fri) -FS-> M` is the close of Friday); `False` means the start
  (held by the project start, an SNET, the data date, or a recorded start) and is
  the value for every task that is not a network-placed milestone. Set by
  `schedule()`; an input value is ignored. Appended after `scheduled_start`, so
  positional construction of `Task` is unchanged.
- **`MonteCarloResult.p50_at_day_start` / `p80_at_day_start` / `p95_at_day_start`
  (#4204).** Each percentile's edge-of-day reading, the Monte Carlo counterpart of
  `Task.milestone_at_day_end`: `True` means the percentile is the *start* of its
  shown day (the finish is a start-of-day milestone). Also emitted by `to_dict()`.
  Appended after `sensitivity` with a default of `False`, so positional
  construction is unchanged.

### Fixed

- **Monte Carlo percentiles are ordered by working-time finish, not by shown day
  (#4204).** A start-of-day milestone is shown one working day past the working
  time it occupies, so ordering runs by shown day ranked the start of a Monday
  after the end of the Friday before it although neither is later. `p50`/`p80`/
  `p95` are now order statistics over each run's working-time finish position.
  Where runs at that position are shown on different days (the end of a Friday
  and the start of the Monday after it), each percentile is shown on the day its
  rank lands on with runs ordered by position, then shown day, and reads as the
  start of the day when that day lies past the position. So it stays a two-sided
  quantile of `distribution`: at least 80% of runs are shown on or before P80, and
  fewer than 80% (plus one run) strictly before it. When no run
  finishes on a start-of-day milestone the dates are exactly those the previous
  shown-day ranking gave; the `distribution` is unchanged.
- **A deterministic `monte_carlo()` now finishes on the CPM finish when a live
  task's `actual_start` falls on non-working time (#4175).** `schedule()` keeps a
  recorded start verbatim, even on a weekend or holiday, but Monte Carlo's
  working-day index snapped an in-progress task's or milestone's start to the
  next working day. A downstream calendar-day lag then landed on the other side of
  a weekend, so a project with no uncertainty could simulate 2–3 working days
  past its CPM finish. Monte Carlo now reads the recorded date for a live
  milestone's instant, for SS successors, and for a milestone that is the project
  finish. The `monte_carlo()` docstring's "at most one working day after" bound
  (#2833) is replaced: with deterministic durations, every percentile equals
  `schedule().project_finish`.

- **A zero-duration milestone is an instant, not a one-day task (#4079).**
  `schedule()` gave every zero-duration task a working day of its own, so each
  milestone on a path delayed its successors by one working day, unlike MS Project
  and Primavera P6. A milestone now sits on its driving predecessor's finish day
  (or at the start of its floor day when nothing drives it), and links out of it
  measure from that instant, so `A -FS(l1)-> M -FS(l2)-> B` schedules exactly as
  `A -FS(l1+l2)-> B` for non-negative lags. The backward pass, total and free
  float, driving edges, `derive_value()`, and `monte_carlo()` follow the same
  rule; with deterministic durations every percentile still equals the CPM
  finish. The convention is documented in the `trueppm_scheduler.engine` module
  docstring. Behavior change: schedules containing milestones finish earlier by
  one working day per milestone on the critical path.
- **A lag landing a milestone on a weekend or holiday shows it at the next
  working start (#4173).** The #4079 rule showed a milestone that follows work at
  the end of the working day before its instant, even when non-working days lay
  in between, while an SS link to the same working-time position showed the next
  working day. So lengthening a predecessor could move a milestone, and
  `project_finish`, from Monday back to Friday, and `monte_carlo()` could report
  P50 before the CPM finish on a Finish-to-Start / Start-to-Start network. Such a
  milestone now sits at the start of the next working day
  (`milestone_at_day_end` is `False`), as MS Project places an elapsed lag that
  ends on non-working time. A milestone whose predecessor finishes on a working
  day is unchanged when it has no lag or its lag ends on a working day; one
  following a recorded `actual_finish` on a non-working day now also shows at
  the start of the next working day rather than the working day before it. The Rust/WASM engine moves with it.
- **Free float before a milestone shown at the start of a day counts the
  slip it absorbs (#4180).** Free float compared a milestone successor by its raw
  instant, so `A(4d) -FS+2d-> M` (M at Sunday midnight, shown Monday) gave `A`
  zero free float and reported `A -> M` as a driving edge, although slipping `A`
  a day moves `M` only to Monday midnight, still shown Monday. A milestone that
  reads as the start of a day now admits any midnight up to the one that opens
  that day, capped by its own successor links so a lag cannot carry the move
  downstream. `A` has one day of free float, and the edge no longer drives. A
  milestone that reads as the end of a day is unchanged (`A -FS+1d-> M` keeps
  zero). `derive_value(..., Quantity.FREE_FLOAT)` and the Rust/WASM engine move
  with it. Introduced by the #4079 change above; never released.
- **Work before a project-ending milestone shown at the start of a day keeps
  its total float (#4174).** When the finish instant already reads as the start
  of a day (`project_finish` on or after it), a milestone ending the project may
  sit as late as the midnight that opens the next working day, since both show
  the same finish. The late pass used to admit only the raw instant, so
  `A(4d) -FS+2d-> M` (M at Sunday midnight, shown Monday) gave `A` zero total
  float and put it on the critical path, although slipping it a day moves `M`
  only to Monday midnight, still shown Monday. `A` now has one day of float. A
  finish instant that reads as end of day is unchanged: `A -FS+1d-> M` (Saturday
  midnight, shown Friday) keeps `A` at zero float, which is correct under #4173's
  display rule, because a one-day slip moves the shown finish to Monday.
  Introduced by the #4079 change above; never released. The Rust/WASM engine
  moves with it. This fix measures float by the shown day, not the underlying
  working-time position; the next entry (#4183) fixes a start-of-day milestone
  overstating float under that same measure.
- **Float no longer lets a start-of-day milestone slip onto an end-of-day
  finish (#4183).** When the project ends at the end of a day (`W(5d)` finishing
  Friday, finish instant Saturday midnight), a milestone placed by an SS link
  from work reads as the start of a day. `X(2d) -SS+3d-> M` puts `M` at Thursday
  midnight and reported two days of float for `X`, but a two-day slip lands `M`
  on Saturday midnight, which it shows as Monday, and `project_finish` moves.
  The late pass now caps such a link at the last working day on or before
  `project_finish`, so `X` has one day. The cap is per link: an FS predecessor
  of the same milestone, which places it at the end of a day, keeps the full
  window. The Rust/WASM engine moves with it.
- **A milestone's own total float is measured to the reading it is shown with
  (#4183).** This redefines a milestone's own float, beyond the case above: a
  start-of-day milestone floats only as far as that reading can go without
  moving the shown `project_finish` (`_float_late_instant`). Near the finish
  this makes `total_float` the working-day span between the milestone's shown
  `early_start` and `late_start`, which `_late_display` already capped. Other
  networks change too: a lone milestone held by a floor, or `X -SF-> M`, can
  report one day less float (5 → 4 in the cases found), and some such
  milestones become `is_critical` and join `critical_path`. It is not a general
  invariant: a start-of-day milestone whose late instant is a weekend midnight
  before the finish is still shown late on the Friday while its float runs
  through that Friday.
- **Free float stops before a midnight reading tie (#4183).** An end-of-day
  milestone (`A(3d) -FS-> M`, Thursday midnight, shown the end of Wednesday)
  flips to the start-of-day reading when a start-of-day proposal ties its
  instant, so `X(2d) -SS+1d-> M` moved `M`'s shown day on a two-day slip while
  reporting two days of free float. Free float through a link that would read
  the instant as start of day is now inverted against the day before it
  (`_free_start_ref`, Rust `free_start_ref`), including a zero-lag link carrying
  a start-of-day milestone's reading. `X` has one day.
- **A long calendar exception no longer makes `schedule()` slow in proportion
  to the number of dependencies (#4161).** Every dependency edge snaps a date to
  a working day in the forward pass, the backward pass, and the free-float
  calculation. Each of those snaps used to walk the calendar one day at a time,
  so one exception range close to `MAX_CALENDAR_SCAN_DAYS` long (for example a
  "closed until further notice" entry) cost about 32 ms per edge: 200 edges took
  6 s and 5,000 edges took minutes. Snaps now skip a whole exception range in one
  step, and working-day spans are counted arithmetically, so the same 5,000-edge
  project schedules in under 0.1 s. Dates, floats, and the
  `MAX_CALENDAR_SCAN_DAYS` / date-range errors are unchanged. `monte_carlo()` was
  never affected.

- **The sdist's test suite runs (#3856).** Running `pytest` in an unpacked
  sdist errored at collection on `tests/test_wasm_conformance.py`, which needs
  the monorepo's `packages/wasm-scheduler/fixtures` tree, so zero tests ran.
  That module now skips when its fixtures are absent, and the rest of the suite
  runs. Inside a monorepo checkout a missing fixture is still a hard failure.

### Documentation

- **Conventions reference (#4136).** The README gains a *Conventions* section
  listing every modeling rule the engine commits to — lag units, the constraint
  set, FF/SF placement, progress rules, float definitions, the sampling
  distribution — each linked to the issue or ADR that decided it, with the rules
  that differ from MS Project / Primavera P6 marked.
- **PERT shape named (#4133).** `_sample_pert` and `monte_carlo()` now state the
  convention: a Beta fitted by method of moments to the classic PERT mean and
  `(p − o) / 6` standard deviation, not the λ=4 Beta-PERT. No sampling change.
- **Seed reproducibility scoped (#4099).** A fixed `seed` reproduces P50/P80/P95
  on the same numpy and `trueppm-scheduler` versions; numpy does not promise its
  random streams across releases.
- **FF/SF convention decided (#3806).** An FF/SF-driven task stays contiguous and
  right-aligned on its pinned finish (the MS Project convention), so the
  "never earlier than CPM" guarantee holds on FS/SS-only networks. No engine
  change.
- **Timing claim corrected (#3859).** `monte_carlo()`'s docstring said 10,000 runs
  on a 200-task project took "well under 100 ms"; measured, it is about 60–100 ms
  on a current laptop CPU and more on a CI runner. A loose benchmark in
  `tests/test_bench.py` now keeps the figure from drifting.
- **Milestone display rule stated (#4178).** `ScheduleResult` and `Task` now say
  that `project_finish` and a milestone's `early_finish` are the day the finish
  is *shown* on, which edge of it `milestone_at_day_end` names, and that the
  shown day can move across a weekend or holiday while the working-time finish
  does not. Compute slip in working time, not as a calendar-day difference of two
  finishes. The docstring example runs as a test. No engine change.

- **The test suite passes on Python 3.14 (#3787).**
  `test_project_from_json_deep_nesting_message_is_exact` nested its payload
  20,000 levels deep, which 3.14's JSON parser handles without overflowing, so
  the test failed on 3.14 even though `Project.from_json` still refuses deeper
  documents. The test now nests 1,000,000 levels. Library behavior is unchanged.

## [0.4.0b4] - 2026-09-23

### Fixed

- **A non-working `actual_start` no longer spends one working day of the task's
  duration (#3963).** `duration` counts working days, but the forward pass began
  its expansion *on* the recorded start date — which `schedule()` deliberately
  keeps verbatim, since an actual can legitimately be logged over a weekend
  (ADR-0132 §2). The walk now begins at the next working day; the recorded date is
  unchanged and still floors `early_start`. `_start_from_finish` is snapped
  symmetrically, so a completed task pinned by a non-working `actual_finish` also
  spans its full duration.

  Three observable consequences:

  - `early_finish` (and every date downstream of it) moves up to **one working
    day later** on an affected task. A project whose actuals all fall on working
    days produces byte-identical output.
  - `late_start`/`late_finish` could previously precede `early_start`/`early_finish`
    — an inverted window that `_working_days_between` clamped to zero float,
    reporting the task as critical. The late window is now floored at the early
    one, which also covers a zero-duration milestone pinned to a non-working
    actual (no working days to lay out, so nothing to snap).
  - **That floor is not local to the floored task.** The backward pass runs in
    reverse topological order and reads each successor's `late_start`, so raising
    one task's late window moves its predecessors' `late_start`, `late_finish` and
    `total_float` too — including predecessors that carry no actual and sit
    entirely on working days. On `P → M(milestone, weekend actual) → S`, `P`'s
    total float goes from 1 working day to 2. The new value is the correct one,
    but it is a wider change than "the floored task's own window moved."
  - `schedule()` and `monte_carlo()` returned **different finishes for the same
    fully deterministic project**; `monte_carlo()` was the one that was right
    (it already snapped the floor forward, #2833). They now agree for any task
    with remaining duration >= 1.

  The Rust/WASM engine takes the identical change, as does TruePPM's in-browser
  drag-preview engine (outside this package). `wasm:conformance` compares two of
  the three implementations to each other and so was structurally blind to this —
  they implemented the same rule and agreed wrongly — which is why the guard added
  with the fix is a property over generated projects, not another shared fixture.

### Changed

- **`DerivationContribution.kind` can now be `late_window_floor`.** `derive_value()`
  reports it as the binding term for `late_start`/`late_finish` when the late window
  was raised to the early one — which only happens when the early window sits on a
  non-working day, i.e. a recorded actual the engine keeps verbatim. Previously that
  case fell through to `duration_from_late_finish` and attributed the date to a
  duration expansion that had not occurred. Additive: `kind` is a plain string and
  no existing value changed meaning, but a consumer switching exhaustively on it
  will see a new member.

## [0.4.0b3] - 2026-09-19

_No library-facing changes in this release._

## [0.4.0b2] - 2026-09-19

_No library-facing changes in this release._

## [0.4.0b1] - 2026-09-15

### Added

- **Seven new names on the public `__all__` surface** — a ~20% expansion, none of
  it previously recorded here. Diffed against `scheduler-v0.3.0a3`:
  - **`DrivingEdge`** and **`ScheduleResult.driving_edges`** — the predecessor edge
    that determines each task's early start, so a consumer can walk the chain that
    actually drives a date rather than re-deriving it.
  - **`Derivation`**, **`DerivationContribution`**, **`Quantity`** and
    **`derive_value()`** (ADR-0218) — the explainability surface: ask why a
    computed quantity has the value it has and get back the inputs that produced
    it, rather than a number with no provenance.
  - **`UnknownTaskError`** — now exported, and now a `SchedulerError` subclass (see
    *Fixed*), so `except SchedulerError` catches it.
  - **`MAX_DEPENDENCIES`** — the dependency-count ceiling, exported so a caller can
    check against it instead of discovering it by raising.

### Added

- **`Task.scheduled_start`** (ADR-0752): a new CPM-computed field naming the
  task's *span* start, as distinct from `early_start`, which (since ADR-0132)
  names the *remaining-work window* start for an in-progress task.
  `scheduled_finish` is not a new field — it is always identical to
  `early_finish`, so callers read that under its existing name.
  `derive.Quantity` gains `SCHEDULED_START = "scheduled_start"` and
  `derive_value()` explains it: not-started/complete tasks cite `early_start`
  (the windows coincide); an in-progress task with a recorded `actual_start`
  cites that actual; otherwise the citation is the calendar-aware full-duration
  back-off from `early_finish`. See the ADR for the full per-state derivation
  table and the `scheduled_start > duration`-when-`actual_start`-is-set
  behavior, which is deliberate. It is declared **last** in the `Task` field
  list, so `Task`'s positional signature is unchanged from 0.3.0a3 — see the
  `### Changed` note below for why that placement is load-bearing.
- The public API is now property-fuzzed in CI: every input to `schedule()`,
  `monte_carlo()`, `find_cycle()`, `expand_summary_dependencies()`, and
  `Project.from_json()` either succeeds or raises a documented `SchedulerError`
  (`InvalidScheduleInput` / `CyclicDependencyError` / `SimulationCapExceeded`) —
  an uncaught exception or a hang on any input is treated as a contract
  violation. A fast deterministic sweep runs on every change; an exhaustive
  stochastic sweep runs on a schedule. This is robustness/contract fuzzing, not
  security/memory-safety fuzzing (#1456).

### Changed

- **`Task.scheduled_start` is declared last, so `Task`'s positional field order
  is identical to 0.3.0a3.** While unreleased, the new field sat between
  `late_finish` and `total_float`, which shifted the twelve fields after it by
  one positional slot. Because dataclasses perform no runtime type validation,
  a consumer constructing `Task` positionally would have received **no
  `TypeError`** — a `timedelta` intended for `total_float` would simply have
  been stored in `scheduled_start`, `total_float` would have taken the old
  `free_float` argument, and the wrong values would have propagated silently
  into `schedule()`'s float and criticality output. Moving the field to the end
  of the class keeps the addition genuinely additive for anyone pinned to
  0.3.0a3. Field order in an exported, non-`kw_only` dataclass is part of this
  package's public contract; new fields append. The order of every dataclass in
  `__all__` is now pinned by `tests/test_public_surface.py`, so the next
  mid-sequence insertion fails at test time rather than in a consumer's
  schedule (#2836).
- **`Calendar.exceptions` is now an immutable `tuple` of frozen `DateRange`s.**
  Any iterable is still accepted at construction, so `Calendar(exceptions=[...])`
  — including the whole `from_dict` / `from_json` path — is unchanged. What is no
  longer possible is in-place mutation: `cal.exceptions.append(...)`,
  `cal.exceptions[0] = ...`, and `range.start = ...` now raise rather than leave
  the cached index stale (#2462). Assign a new set instead:

  ```python
  cal.exceptions = [*cal.exceptions, DateRange(holiday, holiday)]
  ```

  Reassignment is normalized and invalidates the cache, so this is the one
  supported way to change a calendar's exception set.
- `schedule` CLI output now labels the project finish as the earliest feasible
  date and points at `monte-carlo` for confidence dates.
- `monte-carlo` CLI output now carries the reading of each percentile (P50 is a
  midpoint, P80 is the commitment date, P95 is for external deadlines), and
  explains a collapsed distribution — every run finishing on the same date
  because no task carries a three-point estimate — rather than printing three
  identical dates with no comment. `--json` output is unchanged.
- **`schedule()` and `monte_carlo()` are faster on large projects.** Cycle
  detection no longer runs an eager `nx.find_cycle` on every call — the
  topological sort the engine already performs raises on a cyclic graph, so the
  expensive edge-DFS runs only on the error path to reconstruct the offending
  cycle for the message. And `schedule()` shallow-copies its input tasks instead
  of deep-copying them: every `Task` field is an immutable scalar, so a
  field-level copy is semantically identical while skipping the recursive
  `deepcopy` machinery. On a 5,000-task / ~5,700-edge project a full `schedule()`
  run drops from roughly 400 ms to under 100 ms with identical output (#1526).
- **`monte_carlo()` is ~2.3× faster at high run counts.** The duration-sensitivity
  tornado is now ranked over a fixed subsample of the runs (the first 2 000 rows of
  the sampled matrix) instead of every run, and its per-column rank sort uses the
  default (unstable) introsort — correct here because the average-rank convention
  groups purely by exact value equality. The tornado cost is now independent of the
  run count rather than scaling with it. **P50/P80/P95 percentiles are computed over
  the full distribution and are byte-identical to before** — only the sensitivity
  ranking is subsampled, and Spearman rank correlation converges well within the
  subsample (top-N ranking within ~0.02 of the full-run correlation) (#1525).

#### Input contract narrowed — a document that scheduled on 0.3.0a3 may now raise

Nine validation tightenings landed in 0.4. Each is a deliberate fix, and each
turns previously-accepted input into an `InvalidScheduleInput` (or, where noted,
a different documented `SchedulerError`). **This is the list to read before
upgrading a pipeline**, because the failure surfaces at runtime on real data
rather than at install time:

| Narrowed | Was accepted on 0.3.0a3 | Now |
|---|---|---|
| Date strings must be strict `YYYY-MM-DD` | compact (`20260401`), ordinal, and week-date ISO forms | rejected |
| Duplicate JSON object keys | silently kept the last value | rejected as malformed |
| Sub-microsecond duration precision | silently truncated | rejected |
| Non-whole-day durations and lags | accepted and rounded | rejected |
| Duplicate `(predecessor, successor)` pairs | accepted as a single edge | rejected |
| Dependency count | unbounded | capped at `MAX_DEPENDENCIES` (100 000) |
| Calendar exception count | unbounded | capped at `MAX_CALENDAR_EXCEPTIONS` (100 000) |
| `Calendar.from_dict` types for `working_days` / `hours_per_day` / `timezone` | coerced loosely | type-strict |
| **SS/SF dependencies *from* a summary task** (ADR-0370) | accepted, with undefined semantics | **rejected outright** |

The last is a behavior removal rather than a validation tightening: a summary
task's start is derived from its children, so a start-anchored link *out of* one
had no well-defined meaning. Re-anchor such a link to the child that really
drives it.

### Fixed

- **`monte_carlo()` never applied the `actual_start` early-start floor, so every
  percentile on an in-progress project could land *earlier* than the `schedule()`
  finish** — a risk forecast under-reporting risk. `_forward_pass` has floored work
  already underway at its recorded actual start since ADR-0132 §2, but the Monte
  Carlo floor helper merged only the `planned_start` (SNET) pin and the data date,
  so a task that actually began after the data date was simulated from the data
  date instead — sampling a window CPM had already rejected. With a data date of
  31-Jul, a 20-day task 50% done that actually started 10-Aug, `schedule()`
  finished 21-Aug while P50, P80 and P95 all came back 13-Aug. The floor is now a
  three-way maximum (SNET pin, data date, actual start), matching the deterministic
  pass. A *non-working* actual is snapped forward to the next working day here
  while `schedule()` keeps it verbatim: the Monte Carlo working-day index holds
  working days only, so the date has no offset of its own, and snapping forward is
  the only stand-in that can report at most one working day *late* rather than
  early. Reachable from any consumer that records progress, including callers who
  never set `status_date` at all (#2833).
- **`monte_carlo()` ignored the `planned_start` floor and every predecessor
  constraint on a task complete by `percent_complete` alone, so its percentiles
  could land *earlier* than the `schedule()` finish** — a risk forecast
  under-reporting risk. `_forward_pass` runs this third completed-task branch
  (100% complete, `actual_start` and `actual_finish` both `None`) through network
  logic, taking the latest of the project-start anchor, the `planned_start` SNET
  floor, and each predecessor constraint (ADR-0136). The Monte Carlo pass pinned it
  at the bare project-start anchor instead: a 10-day task pinned to start two weeks
  out simulated ten working days early, in every run. Completed tasks' pins are now
  read off an actual deterministic forward pass rather than a transcription of one,
  so the branch cannot drift again; both dropped constraints are run-invariant, so
  the constant pin the vectorized path relies on is preserved. Reachable from any
  import path that carries `percent_complete` without actuals (MS Project, CSV,
  Jira), from seed data, and from direct library use, where the caller builds
  `Task` objects itself (#2572).
- **`monte_carlo()` mis-anchored successors of a completed task, so its
  percentiles disagreed with the `schedule()` finish.** Both defects broke the
  documented contract that a fully deterministic project simulates to precisely
  the CPM finish date, and both were found by differential-fuzzing the two passes
  against each other.
  - A completed task recording an `actual_finish` but **no** `actual_start` had
    its simulated start pinned exactly one working day before the finish
    regardless of duration, instead of a full duration back the way
    `schedule()` lays it out. Every Start-to-Start / Start-to-Finish successor was
    therefore anchored up to `duration - 1` working days late (#2460).
  - A completed task whose recorded actual fell on a **non-working day** had its
    successors anchored off the nearest working day, while `schedule()` keeps the
    recorded date verbatim (actuals are truth). The two diverged whenever the link
    carried a lag or was start-anchored, and a project could be reported as
    finishing on a weekend. Completed tasks' constraints are now resolved from
    their recorded dates in scalar date arithmetic, and the terminal finish is
    floored at the latest recorded completion — replacing the per-offset override
    that could attribute a completed task's weekend date to an unrelated live task
    (#2461, completing the terminal-date-only fix in 0.4.0b1).
- **A `Calendar` served stale working-day answers after its exceptions were
  edited in place.** The cached exception index was keyed on the length and
  identity of the `exceptions` list, so replacing an element (or mutating a
  `DateRange`) changed nothing the cache could observe and `is_working_day` kept
  answering from the pre-edit calendar — silently scheduling against holidays that
  had been removed (#2462).
- **`monte_carlo()` honors per-task calendars (ADR-0120 D3).** A project
  declaring a non-empty `Project.calendars` registry was rejected outright with
  `InvalidScheduleInput`, so the program-scoped case per-task calendars exist to
  serve — member projects each keeping their own working week — had a
  deterministic `schedule()` finish and no distribution around it. The
  vectorised pass now works in per-calendar working-day space: a task's duration
  expands on its own calendar, each edge's precomputed delta array carries the
  conversion from the predecessor's space into the successor's (lag is consumed
  on the successor's calendar, exactly as `schedule()` does), and the per-run
  project maximum is taken against a reference index built from the *union* of
  every calendar's working days — raw offsets from different working weeks are
  not comparable, and the larger offset is frequently the earlier date. A fully
  deterministic mixed-calendar project simulates to precisely its CPM finish
  date, which is the contract the suite asserts across all four dependency types
  at zero, positive, and negative lag. **Single-calendar projects take the
  unchanged fast path and their seeded P50/P80/P95 are byte-identical** (#1385).
- **`UnknownTaskError` is now caught by `except SchedulerError`.** It subclassed a
  bare `ValueError`, so the exception raised by `derive_value()` on an unknown task
  id escaped the `SchedulerError` catch-all the base class documents. Reparented to
  `SchedulerError` (still an `is-a ValueError`) ahead of the 1.0 public-surface
  freeze, where interposing the common base would become a breaking change (#2180).
- **The SCRUM/velocity path holds the documented exception contract.** Two hostile
  agile inputs reachable from `Project.from_json(...)` leaked raw exceptions:
  `story_points` over a near-zero mean velocity overflowed float64 and raised a bare
  `OverflowError` from `math.ceil(inf)`, and a non-numeric `sprint_length_days` raised
  a bare `TypeError` from the `<= 0` compare. Both now raise `InvalidScheduleInput`.
  `sprint_length_days` is pinned to an integer on `from_dict`/`from_json` (rejecting
  `bool` and fractional floats like `2.5`), closing a silent Python↔Rust divergence
  where Python simulated a fractional sprint the Rust engine only round-trips as an
  integer (#2178).
- **`Task.percent_complete` now holds the documented exception contract on the
  direct-object API.** A non-finite value (`NaN`/`±inf`) or a non-numeric value
  passed to a `Task` built directly (not via `from_dict`/`from_json`) previously
  escaped as a bare `ValueError`/`TypeError` from `schedule()` while `monte_carlo()`
  silently forecast the *same* input as 0% complete — the two passes disagreeing on
  identical input. Both passes now raise `InvalidScheduleInput`. `None` and finite
  out-of-range values (`<0`, `>100`) remain clamped, consistent with `from_dict`
  (#1452).
- **`monte_carlo(seed=…)` now validates its seed.** A negative or non-integer
  `seed` previously escaped as a bare numpy `ValueError`/`TypeError`; it now raises
  the documented `InvalidScheduleInput`. `None` and any non-negative `int` remain
  valid (#1453).
- **Backward pass no longer corrupts float/critical path across per-task
  calendars.** When a predecessor and its successor use different calendars
  (per-task calendars, #1490), the backward pass computed the predecessor's own
  `late_start`/`late_finish` but snapped them onto the *successor's* calendar
  instead of the predecessor's own, which could yield `late_finish <
  early_finish` (impossible in valid CPM), under-reported total/free float, and
  spurious tasks entering the critical path. The backward pass now snaps every
  predecessor-owned date on the predecessor's own calendar, matching the forward
  pass's existing convention. Single-calendar scheduling is unaffected.

### Documentation

- New README section **Interpreting the output**: `schedule()` returns a
  deterministic, optimistic single date; `monte_carlo()` returns the
  distribution it sits in. Previously the package documented the mechanics of
  both passes but never their relationship.
- Renamed the README's `Monte Carlo determinism` section to
  **Reproducibility (seeded runs)**. It describes seeded repeatability, but was
  the package's only heading containing "determinism" — the word readers search
  for when they want the single-date-vs-distribution distinction.
- `schedule()`, `monte_carlo()`, and `MonteCarloResult` docstrings now state how
  their output should be read.

## [0.3.0a3] - 2026-06-29

_No library-facing changes in this release._

## [0.3.0a2] - 2026-06-29

_No library-facing changes in this release._

## [0.3.0a1] - 2026-06-28

### Added

- Per-task calendars: a `Task` can opt into its own working week via
  `Task.calendar_id` and a `Project.calendars` registry, so a single schedule can
  mix tasks that follow different calendars (the substrate for cross-project
  dependencies within a program). Duration arithmetic uses the task's own calendar;
  lag on a dependency is counted on the successor's calendar. Honored by the CPM
  `schedule()` pass; `monte_carlo()` continues to sample on the pass-level
  calendar. Backward compatible — a project with no `calendars` registry is
  unchanged (#1117).
- Agile-aware Monte Carlo: scrum/flow tasks can be sampled from team velocity
  rather than a three-point estimate, via `DeliveryMode` (#411).
- CycloneDX SBOM (`sbom.cdx.json`) generated, validated, and retained as a
  release artifact at publish time (#936).

### Changed

- WASM/Python validation parity: PERT ordering, start-no-earlier-than span
  caps, and panic/error paths now behave identically across the Rust and Python
  engines.
- Bounded the cycle-check graph expansion to keep `find_cycle` / scheduling from
  doing unbounded work on adversarial summary-dependency graphs.
- Monte Carlo lag-delta precompute is vectorized (`searchsorted`) instead of a
  per-cell Python loop, cutting the worst-case build time on networks with many
  distinct lag values roughly 7× (#1205).
- `Calendar.is_working_day` resolves exceptions via a cached merged-interval
  bisect (O(log E)) rather than a linear scan, and the engine rejects a calendar
  with more than 100,000 exception ranges (#1206).
- `expand_summary_dependencies` now bounds the leaf cross product with the same
  `MAX_EXPANDED_EDGES` cap as the cycle-check path, and caches leaf resolution
  per node (#1208).

### Fixed

- Monte Carlo correctness: milestone handling, velocity index lookups,
  start-no-earlier-than (SNET) lag, and start-to-finish lag.
- Critical-path topological ordering and free-float computation.
- Determinism: a fixed `seed` produces stable P50/P80/P95 results.

### Security

- Deserialization and the public engine API only raise documented exceptions on
  hostile input: deeply nested JSON (`RecursionError`), a start date that would
  overflow the representable date range (`OverflowError`, previously reaching the
  CLI and worker), a non-object top-level document (`AttributeError`), and
  type-confused direct calls (`find_cycle`, non-`timedelta` durations/lags, a
  `datetime` where a `date` is expected, non-numeric velocity samples, a
  non-integer `working_days` mask) now all surface as `InvalidScheduleInput`
  (#1207, #1209).

## [0.2.0a1] - 2026-05-31

### Changed

- Pre-1.0 public-surface decisions: settled the exported `__all__` API and
  raised the Monte Carlo task cap.

### Fixed

- Hardened the CPM engine against hostile calendars (e.g. exceptions blanketing
  the entire search window) and duplicate task IDs.
- Reject structurally-valid-but-out-of-range input up front instead of spinning
  on a degenerate project: duration, lag, and cumulative project-span limits
  (`InvalidScheduleInput`), closing a residual Monte Carlo denial-of-service
  vector (#749).
- `Project.from_json()` rejects the non-standard JSON literals `NaN`,
  `Infinity`, and `-Infinity`.

### Security

- Bounded cumulative project span (`MAX_PROJECT_SPAN_DAYS`) so a small task
  count with extreme durations/lag can no longer exhaust CPU (#749).

## [0.1.0a1] - 2026-05-15

### Added

- Initial public alpha of the critical-path-method and Monte Carlo
  schedule-risk engine.
- Forward/backward CPM pass with all four dependency types (FS, SS, FF, SF),
  total/free float, and critical-path flagging.
- Calendar-aware working-day arithmetic (weekend skip + holiday exceptions).
- Monte Carlo schedule-risk simulation via PERT-Beta distributions
  (numpy-vectorized) producing P50/P80/P95 completion dates.
- JSON round-tripping for plans (`Project.from_json()` / `Project.to_json()`).
- Cycle detection that names the offending task IDs (`CyclicDependencyError`).
- CLI: `trueppm-scheduler schedule` / `trueppm-scheduler monte-carlo`.

[Unreleased]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.4.0b4...main
[0.4.0b4]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.4.0b3...scheduler-v0.4.0b4
[0.4.0b3]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.4.0b2...scheduler-v0.4.0b3
[0.4.0b2]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.4.0b1...scheduler-v0.4.0b2
[0.4.0b1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a3...scheduler-v0.4.0b1
[0.3.0a3]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a2...scheduler-v0.3.0a3
[0.3.0a2]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a1...scheduler-v0.3.0a2
[0.3.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.2.0a1...scheduler-v0.3.0a1
[0.2.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.1.0a1...scheduler-v0.2.0a1
[0.1.0a1]: https://gitlab.com/trueppm/trueppm/-/tags/scheduler-v0.1.0a1
