---
name: scheduler-engine
model: opus
description: >
  CPM, Monte Carlo, and scheduling algorithm work for the TruePPM scheduling
  engine. Use when implementing or modifying the engine, adding new algorithm
  features, or debugging scheduling correctness issues. This is the core IP of
  TruePPM, and it lives in two coordinated implementations: the separable Apache
  2.0 Python library `packages/scheduler` (`trueppm-scheduler`, ships on PyPI)
  and the Rust + petgraph CPM engine `packages/wasm-scheduler` (compiled to WASM
  via wasm-pack for browser/offline recompute). A change to scheduling semantics
  must keep the two in conformance.
---

# Scheduler Engine Skill

You are working on trueppm-scheduler, a pure Python library with ZERO Django dependencies.

## Architecture Rules
- **No Django imports.** This library must work standalone: `pip install trueppm-scheduler`
- **Input/output via data classes.** Accept Project/Task/Dependency objects, return computed fields.
- **No database access.** The library never touches PostgreSQL. Django loads data, calls the engine, writes results back.
- **Deterministic by default.** Same input = same output (Monte Carlo uses seeded RNG for reproducibility in tests).
- **networkx for graph operations.** DAG construction, topological sort, cycle detection.
- **numpy for Monte Carlo.** Vectorized sampling across all simulations for performance.

## CPM Algorithm Spec
1. Build DiGraph from tasks (nodes) + dependencies (edges)
2. Cycle detection (DFS). Return cycle chain on failure.
3. Forward pass (topological order): compute early_start, early_finish
4. Backward pass (reverse topological): compute late_start, late_finish
5. Float: total_float = late_start - early_start; free_float = min(succ.early_start) - early_finish
6. Critical path: tasks where total_float == 0
7. Dependency types: FS (default), SS, FF, SF — each modifies which date is used
8. Calendar-aware: working days expansion, skip holidays
9. Incremental mode: recompute only from changed_task_id downstream

## Monte Carlo Spec
1. For each task: sample duration from PERT beta distribution (O, M, P)
2. Run N simulations (default 10,000). Vectorize with numpy.
3. Output: P50, P80, P95 dates. Criticality index per task. Sensitivity ranking.
4. Seed RNG for reproducible tests.

## WASM engine — `packages/wasm-scheduler`
The browser (live impact simulation) and mobile (offline CPM) recompute path is
served by `packages/wasm-scheduler`: a Rust CPM engine built on **petgraph** and
compiled to WebAssembly with **wasm-pack**. It is a coordinated reimplementation
of the same CPM semantics as the Python library, not a Pyodide wrapper.
Target: <10ms incremental recalc for 5K tasks.

Neither implementation is declared "canonical" — they must agree. Any change to
scheduling semantics in one must be mirrored in the other and proven by the
conformance suite. CI gates for the package:

- `wasm:lint` — `cargo clippy --all-targets -- -D warnings` (mirrored locally by
  `make pre-push-wasm`; there is intentionally no `cargo fmt --check` gate)
- `wasm:conformance` — the **Python** half of cross-engine conformance: the Python
  engine against the shared `packages/wasm-scheduler/fixtures/` corpus and its
  committed `expected/` snapshots. Despite the name it exercises one engine
- `wasm:test` — `cargo test --all-targets`: the Rust unit tests **and** the Rust
  half of conformance (`tests/conformance.rs`, `tests/invalid_conformance.rs`).
  Engine agreement is the conjunction of this job and `wasm:conformance` against
  the one shared oracle, the `expected/` snapshots
- `wasm:license-check` — `cargo deny check licenses` against the `deny.toml` allow-list

The Rust toolchain is pinned (`rust:1.85-slim` in CI). `make pre-push-wasm` is
change-gated to `packages/wasm-scheduler` and skips cleanly when cargo is absent.

## Performance Targets
| Operation | Tasks | Target |
|-----------|-------|--------|
| Full CPM | 1,000 | <50ms |
| Full CPM | 10,000 | <500ms |
| Incremental CPM | 5,000 | <10ms |
| Monte Carlo (10K runs) | 1,000 | <500ms |
| Cycle detection | 10,000 | <10ms |

## Testing Requirements
- Known-answer tests for all 4 dependency types
- Property-based tests (total_float ≥ 0, critical path correctness)
- Statistical convergence tests for Monte Carlo
- Performance benchmarks tracked across commits
- Coverage ≥ 95%

### Cross-engine invariants (assert the relationship, not just the values)
Any code path that computes a schedule **twice** — deterministically and probabilistically, or in Python and in Rust — must be tested on the *relationship between the two results*, not only on each result independently. Two engines can each pass their own known-answer tests while disagreeing with each other.

- **`monte_carlo()` must never finish earlier than `schedule()`.** On a zero-variance project every percentile equals the deterministic finish; on any project, no percentile precedes it. Assert the invariant, not a hard-coded date — a fixed expected date passes for the wrong reason when the anchor changes.
- **Fast paths that "pin" a value must pin what the slow path computes.** A constant-offset shortcut for completed/fixed tasks is only correct if it projects the deterministic result. A shortcut that re-derives its own anchor will drift from the full pass the moment a constraint (SNET/deadline/predecessor) applies to that task, and drift silently — both engines return plausible dates. Prefer projecting the authoritative result over recomputing an independent one.
- **Enumerate the branches of every status/threshold predicate and test each.** A completed task reaches its dates through several distinct branches (actual_finish set; actual_start only; percent-complete with no actuals at all). Cover every branch — and confirm the **fuzz generator** reaches them too. A randomized harness that caps `percent_complete` at 99 never generates the ">= 100 with no actuals" branch no matter how many seeds it runs, so a defect there survives an arbitrarily large fuzz budget. When a bug slips past a fuzzer, check the generator's ranges before adding new test files: the fix is usually one widened bound.
- **A conformance gate must run BOTH halves.** If the Rust half is change-gated on `packages/wasm-scheduler/**` while the Python half is not, a scheduler-only change merges with the two engines never compared — precisely the change most likely to break parity. Verify the gate's trigger conditions, not just its assertions.
