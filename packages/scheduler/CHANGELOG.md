# Changelog

All notable changes to **trueppm-scheduler** are documented here.

This is the changelog for the standalone PyPI package only. The suite-wide
`CHANGELOG.md` at the monorepo root covers the API, web, and deployment
artifacts, which are not relevant to library consumers.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package is in the `0.x` alpha series (`Development Status :: 3 - Alpha`),
the public API — the `__all__` surface of `trueppm_scheduler` — may change
between releases. Pin an exact version (e.g. `trueppm-scheduler==0.2.0a1`).

## [Unreleased]

### Added

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

### Fixed

- Monte Carlo correctness: milestone handling, velocity index lookups,
  start-no-earlier-than (SNET) lag, and start-to-finish lag.
- Critical-path topological ordering and free-float computation.
- Determinism: a fixed `seed` produces stable P50/P80/P95 results.

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

[Unreleased]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.2.0a1...main
[0.2.0a1]: https://gitlab.com/trueppm/trueppm/-/compare/scheduler-v0.1.0a1...scheduler-v0.2.0a1
[0.1.0a1]: https://gitlab.com/trueppm/trueppm/-/tags/scheduler-v0.1.0a1
