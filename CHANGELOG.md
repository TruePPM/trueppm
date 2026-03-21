# Changelog

All notable changes to trueppm-scheduler are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CPM scheduling engine (`schedule()`) with forward/backward pass, float calculation,
  and critical-path identification. Supports all four dependency types (FS, SS, FF, SF)
  with calendar-day lag, calendar-aware working-day arithmetic, weekend skipping, and
  holiday exceptions.
- Monte Carlo probabilistic simulation (`monte_carlo()`) using PERT-Beta distributions
  (method-of-moments parameterisation). Vectorised with numpy; 10 000 runs on a
  200-task chain completes in well under 5 seconds. Returns P50/P80/P95 completion
  dates and the full sorted distribution.
- `CyclicDependencyError` exception with the offending cycle exposed as `.cycle`.
- `ScheduleResult` and `MonteCarloResult` dataclasses with `to_dict()` serialisation.
- CLI entry point `trueppm-scheduler` with `schedule` and `monte-carlo` subcommands.
  Supports `--json` output and `--distribution` flag for the full MC distribution.
- 45 unit and integration tests covering CPM correctness, calendar arithmetic,
  all dependency types, float/critical-path computation, cycle detection, and MC
  statistical properties including a performance benchmark.
