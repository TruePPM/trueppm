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

[Unreleased]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a3...main
[0.3.0a3]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a2...scheduler-v0.3.0a3
[0.3.0a2]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a1...scheduler-v0.3.0a2
[0.3.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.2.0a1...scheduler-v0.3.0a1
[0.2.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.1.0a1...scheduler-v0.2.0a1
[0.1.0a1]: https://gitlab.com/trueppm/trueppm/-/tags/scheduler-v0.1.0a1
