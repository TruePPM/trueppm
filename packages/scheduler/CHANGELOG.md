# Changelog

All notable changes to **trueppm-scheduler** are documented here.

This is the changelog for the standalone PyPI package only. The suite-wide
`CHANGELOG.md` at the monorepo root covers the API, web, and deployment
artifacts, which are not relevant to library consumers.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package is in the `0.x` alpha series (`Development Status :: 3 - Alpha`),
the public API — the `__all__` surface of `trueppm_scheduler` — may change
between releases. Pin an exact version (e.g. `trueppm-scheduler==0.4.0b1`).

## [Unreleased]

## [0.4.0b1] - 2026-07-18

### Added

- The public API is now property-fuzzed in CI: every input to `schedule()`,
  `monte_carlo()`, `find_cycle()`, `expand_summary_dependencies()`, and
  `Project.from_json()` either succeeds or raises a documented `SchedulerError`
  (`InvalidScheduleInput` / `CyclicDependencyError` / `SimulationCapExceeded`) —
  an uncaught exception or a hang on any input is treated as a contract
  violation. A fast deterministic sweep runs on every change; an exhaustive
  stochastic sweep runs on a schedule. This is robustness/contract fuzzing, not
  security/memory-safety fuzzing (#1456).

### Changed

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

[Unreleased]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.4.0b1...main
[0.4.0b1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a3...scheduler-v0.4.0b1
[0.3.0a3]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a2...scheduler-v0.3.0a3
[0.3.0a2]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.3.0a1...scheduler-v0.3.0a2
[0.3.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.2.0a1...scheduler-v0.3.0a1
[0.2.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.1.0a1...scheduler-v0.2.0a1
[0.1.0a1]: https://gitlab.com/trueppm/trueppm/-/tags/scheduler-v0.1.0a1
