---
title: "trueppm-scheduler: A pure-Python critical-path and Monte Carlo schedule-risk engine"
tags:
  - Python
  - project management
  - critical path method
  - CPM
  - Monte Carlo
  - schedule risk
  - scheduling
authors:
  - name: Kelly Hair
    orcid: 0000-0000-0000-0000  # <to be assigned before submission>
    affiliation: 1
affiliations:
  - name: TruePPM, Inc., United States
    index: 1
date: 4 July 2026
bibliography: paper.bib
---

# Summary

`trueppm-scheduler` is a pure-Python library that answers the two questions
every project plan must answer: *what is the earliest this work can finish, and
which tasks cannot slip?*, and *how confident can we be in that date?* It
computes a full critical-path method (CPM) schedule — forward and backward
passes yielding early/late start and finish dates, total and free float, and
critical-path flags — and it forecasts delivery risk with a Monte Carlo
simulation that turns three-point (optimistic / most-likely / pessimistic)
estimates into P50/P80/P95 completion dates.

The library depends only on `networkx` [@networkx] for graph handling and
`numpy` [@numpy] for vectorized sampling. It has no web framework, database, or
GUI dependency, so it embeds equally well in a backend service, a data pipeline,
a Jupyter notebook, or a command-line tool. It is the standalone, Apache-2.0
scheduling core of the TruePPM project-management platform, published
independently so that the scheduling mathematics can be used, audited, and cited
on its own.

# Statement of need

Critical-path scheduling and quantitative schedule-risk analysis are standard
practice in project management, but the tools that implement them well are
either heavyweight desktop applications (Microsoft Project, Oracle Primavera P6)
or hosted SaaS products. Neither is convenient to embed in a program, script it
against a batch of plans, reproduce in a paper, or run in an air-gapped
environment. On the open-source side, `networkx` provides the graph primitives
but no scheduling semantics: it has no concept of a working calendar, of the
four project-management dependency types, of lag, of float, or of PERT-Beta risk
sampling. Practitioners are left to reimplement these repeatedly and
inconsistently.

`trueppm-scheduler` fills that gap with a small, dependency-light library that
implements the scheduling semantics correctly and exposes them through a stable,
typed API. It is intended for two audiences: software engineers who need to
compute schedules inside their own applications without adopting a full platform,
and researchers or analysts who need a scriptable, reproducible CPM and Monte
Carlo engine for studying delivery risk.

# Features and functionality

- **Full CPM pass** with all four Precedence Diagramming Method dependency types
  — finish-to-start, start-to-start, finish-to-finish, and start-to-finish
  [@pmbok] — producing early/late dates, total and free float, and critical-path
  identification. Many lightweight schedulers implement only finish-to-start.
- **Calendar-aware working-time arithmetic.** A configurable working-week
  calendar with holiday exceptions means durations and lag resolve to real
  delivery dates rather than raw calendar days. Lag on a dependency edge is
  counted on the successor's calendar, and per-task calendars are supported for
  schedules that span teams keeping different working weeks.
- **Monte Carlo schedule-risk simulation** using PERT-Beta distributions
  [@malcolm1959; @vose2008], numpy-vectorized for throughput, producing P50/P80/P95
  completion-date forecasts. An optional sensitivity ("tornado") analysis ranks
  which tasks' duration uncertainty most drives the finish date.
- **Agile / velocity sampling.** Tasks can be estimated in story points and
  sampled against a distribution of observed team velocity, allowing agile and
  waterfall work to be forecast in one schedule.
- **Fails loud on bad input.** Cycle detection names the offending task IDs, and
  durations, lag, and overall project span are validated up front against
  explicit bounds, so the engine never silently returns a wrong answer or spins
  on a degenerate graph.
- **Serialization and tooling.** Plans round-trip losslessly to and from JSON,
  Monte Carlo runs are deterministic for a fixed seed (supporting reproducible
  reports and regression baselines), and a `trueppm-scheduler` command-line
  interface exposes both the `schedule` and `monte-carlo` operations.

The package is fully type-annotated (ships `py.typed`, checked under
`mypy --strict`) and covered by an extensive test suite including property-based
contract fuzzing.

# Comparison to related software

Microsoft Project and Oracle Primavera P6 implement CPM and (in P6) risk
analysis comprehensively, but they are proprietary, GUI-first desktop
applications that are difficult to embed or script and cannot be cited as a
reproducible dependency. `networkx` [@networkx] supplies directed-graph
algorithms — including topological sorting and longest-path routines that a CPM
engine builds on — but provides none of the project-scheduling layer (calendars,
dependency types, lag, float, PERT-Beta risk). General-purpose mathematical
optimization and simulation packages can express scheduling as a constraint
problem but require the user to encode the semantics themselves.
`trueppm-scheduler` occupies the space between these: it provides the correct,
ready-to-use project-scheduling and risk semantics as an ordinary,
permissively licensed Python import.

# Acknowledgements

We thank the maintainers of `networkx` and `numpy`, on which this library
builds, and the contributors to the broader TruePPM platform.

# References
