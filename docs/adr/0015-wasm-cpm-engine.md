# ADR-0015: WASM CPM Engine — Rust + wasm-pack

## Status
Accepted with Deferral — web drag-preview uses native TypeScript; Rust WASM is reference implementation for mobile and conformance testing

## Context

TruePPM's scheduling engine (`trueppm-scheduler`) runs server-side as a Python library
(networkx + numpy). Two planned features require client-side CPM:

1. **Live Schedule view drag simulation (#19)**: When a PM drags a task bar, downstream tasks
   must reflow instantly (<10 ms) without a server round-trip.
2. **Offline mobile scheduling (#26)**: When the mobile app is offline, the PM must be
   able to reschedule and see the impact immediately on-device.

A simplified TypeScript forward pass already exists in `packages/web/src/workers/cpmEngine.ts`
for drag preview, but it lacks: backward pass, float computation, calendar awareness,
all four dependency types (SS/FF/SF), and `planned_start` (SNET) constraint support.
It cannot serve as the authoritative client-side engine.

**P3M layer**: Programs and Projects (single-project scheduling). This is OSS.

**VoC summary** (avg 5.4/10): Sarah (PM) 9/10 — hero feature; Marcus 6/10 — indirect
value via fresher data; David 5/10 — wants resource conflict hints (deferred to v2);
Priya 4/10 — passive benefit; Janet 3/10 — cares about data freshness, not tech.

### Forces

- The Python engine is ~300 LOC of CPM logic plus ~150 LOC of Monte Carlo. It is the
  authoritative implementation and must remain so for server-side recalculation.
- Client-side CPM must produce **identical results** to the Python engine for the same
  input — otherwise drag preview shows one schedule and the server computes another.
- Mobile bundle size matters: Sarah is on construction sites with limited bandwidth.
- Cold start matters: the engine loads on first Schedule view interaction, not on page load.
- The scheduler package has **zero Django dependencies** by design (ADR constraint).

## Decision

**Rust + petgraph + wasm-pack** (Option B from issue #39).

Port the CPM forward pass, backward pass, and float computation to Rust. Compile to
WebAssembly via `wasm-pack`. Publish as `@trueppm/wasm-scheduler` within the monorepo.

Monte Carlo is **excluded** from the WASM build — it remains server-side only (per
ADR-0012, the OSS cap of 1,000 runs / 500 tasks is enforced at the API layer, and
vectorized numpy is better suited for this workload than WASM).

### Package structure

```
packages/
└── wasm-scheduler/           # New Rust crate
    ├── Cargo.toml            # petgraph, serde, serde_json, wasm-bindgen, chrono
    ├── src/
    │   ├── lib.rs            # wasm-bindgen entry points
    │   ├── models.rs         # Task, Dependency, Calendar, Project (serde)
    │   ├── graph.rs          # DAG build, cycle detection (petgraph)
    │   ├── calendar.rs       # Working-day arithmetic
    │   ├── forward.rs        # Forward pass (ES/EF)
    │   ├── backward.rs       # Backward pass (LS/LF)
    │   ├── floats.rs         # Total float, free float, is_critical
    │   └── incremental.rs    # Subgraph extraction + incremental recalc
    ├── tests/                # Rust unit tests
    ├── pkg/                  # wasm-pack output (gitignored, built by CI)
    └── README.md
```

### Exposed API (via wasm-bindgen)

```rust
#[wasm_bindgen]
pub fn compute_schedule(project_json: &str) -> String;

#[wasm_bindgen]
pub fn incremental_update(project_json: &str, changed_task_id: &str) -> String;
```

**Input JSON** matches the Python `Project.to_json()` format — same field names, same
types, same semantics. This is the contract between the two implementations.

**Output JSON**:
```json
{
  "project_id": "uuid",
  "project_start": "2026-04-01",
  "project_finish": "2026-07-15",
  "tasks": [
    {
      "id": "uuid",
      "early_start": "2026-04-01",
      "early_finish": "2026-04-10",
      "late_start": "2026-04-03",
      "late_finish": "2026-04-12",
      "total_float": 2,
      "free_float": 0,
      "is_critical": false
    }
  ],
  "critical_path": ["task-uuid-1", "task-uuid-3", "task-uuid-7"]
}
```

`incremental_update` returns the same shape but only includes tasks downstream of the
changed task (subgraph extraction, matching the existing `buildSubgraph.ts` approach).

### Integration points

**Web (packages/web)**:
- Replace `cpmEngine.ts` (simplified TS forward pass) with WASM calls
- Keep the existing Web Worker architecture (`cpmWorker.ts`) — the worker loads the
  WASM module and calls `incremental_update` on `RECALC` messages
- `createCpmWorker.ts` unchanged — worker creation pattern stays the same
- `useDragCpm.ts` unchanged — it posts messages to the worker, receives results

**Mobile (packages/mobile, future #26)**:
- Load WASM via JSI bridge (react-native-wasm or Hermes WASM support)
- Same JSON contract — mobile builds the same project JSON from WatermelonDB
- Falls back to server-side scheduling when online

**Server (packages/api)**:
- No changes. Python scheduler remains authoritative.
- Server-side `recalculate_schedule` Celery task is unchanged.
- The WASM engine is a **preview** — the server always has the last word.

### Conformance testing

A shared fixture suite ensures Python and Rust produce identical results:

```
packages/wasm-scheduler/fixtures/     # Shared JSON test cases
├── basic_fs_chain.json               # Simple FS dependencies
├── all_dep_types.json                # FS, SS, FF, SF with lag
├── planned_start_snet.json           # SNET constraint
├── calendar_exceptions.json          # Non-working days, holidays
├── milestone_tasks.json              # Zero-duration milestones
├── diamond_graph.json                # Convergent dependencies
├── 5000_tasks.json                   # Performance benchmark
└── expected/                         # Expected output for each
    ├── basic_fs_chain.json
    └── ...
```

Both `pytest` (Python) and `cargo test` (Rust) load these fixtures and assert identical
output. CI runs both and fails if they diverge. This is the **single most important
quality gate** — if the fixtures diverge, the drag preview lies to the user.

### Performance targets

| Metric | Target | Rationale |
|--------|--------|-----------|
| `compute_schedule` (500 tasks) | <5 ms | Typical Sarah project |
| `compute_schedule` (5,000 tasks) | <50 ms | Large Marcus project |
| `incremental_update` (5,000 tasks) | <10 ms | Issue #39 acceptance criteria |
| WASM bundle size (gzip) | <80 KB | Mobile bandwidth constraint |
| Cold start (instantiate module) | <20 ms | First drag interaction |

### Migration path for existing TS engine

1. Ship WASM engine behind a feature check (`typeof WebAssembly !== 'undefined'`)
2. If WASM is available, `cpmWorker.ts` loads `@trueppm/wasm-scheduler` and calls
   `incremental_update`
3. If WASM is unavailable (rare: old browsers), fall back to the existing TS forward
   pass — it's imprecise but better than nothing
4. Once WASM is proven stable, remove the TS fallback and `cpmEngine.ts`

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: Pyodide** (Python in WASM) | Exact Python parity, no second codebase | ~10 MB bundle (100x larger), 2-5s cold start, poor mobile experience, numpy WASM overhead |
| **B: Rust + wasm-pack** (chosen) | <100 KB bundle, sub-ms recalc, instant cold start, petgraph is battle-tested | Second codebase to maintain, Rust learning curve, conformance tests required |
| **C: Enhance existing TS engine** | Same language as frontend, no new toolchain, already in Web Worker | Performance ceiling for large projects, still a second codebase (TS ≠ Python), lacks petgraph's graph primitives |
| **D: AssemblyScript** | TS-like syntax compiles to WASM | Immature ecosystem, no graph library equivalent to petgraph, limited community |

**Why not Option C (enhance TS engine)?** The existing TS engine deliberately cuts
corners (no backward pass, no calendar, no float). Enhancing it to full CPM parity
creates a second implementation in a language less suited to graph algorithms, with
worse performance characteristics. If we're maintaining two implementations regardless,
Rust + WASM gives us 10-100x better performance for the same maintenance cost.

**Why not Option A (Pyodide)?** Sarah is on construction sites with limited bandwidth.
A 10 MB download for scheduling is disqualifying for mobile. Cold start of 2-5 seconds
means the first drag interaction hangs — unacceptable for the "instant feedback" UX.

## Consequences

### What becomes easier
- Live Schedule view drag simulation (#19) — downstream tasks reflow in <10 ms
- Offline mobile scheduling (#26) — full CPM on-device, no server needed
- Future: resource conflict preview during drag (VoC David suggestion, v2)
- Future: what-if scenario modeling on client without server round-trip

### What becomes harder
- CPM logic changes must be made in **two** places (Python + Rust) and validated
  against the shared fixture suite — this is the primary ongoing cost
- CI must build Rust/WASM on every commit that touches `packages/wasm-scheduler/`
- Contributors need Rust toolchain for scheduler changes (but not for web/API work)

### Risks
- **Conformance drift**: Python and Rust implementations diverge silently. Mitigated by
  shared fixtures run in CI — any drift fails the build.
- **Rust contributor pool**: Smaller than Python/TS. Mitigated by keeping the Rust code
  focused (CPM only, no Monte Carlo, no Django) and well-documented.
- **WASM support in React Native**: Hermes WASM support is evolving. Fallback: compile
  Rust to native via `cargo-ndk` and call via JSI/TurboModules instead of WASM.

## Implementation Notes

- P3M layer: Programs and Projects (single-project scheduling)
- Affected packages: `wasm-scheduler` (new), `web` (worker integration), `scheduler` (shared fixtures)
- Migration required: no
- API changes: no (client-side only)
- OSS or Enterprise: **OSS** — single-project scheduling is core community functionality

### Implementation order

1. Scaffold `packages/wasm-scheduler/` with Cargo.toml, wasm-pack config, CI job
2. Port `models.rs` + `calendar.rs` (data structures and working-day arithmetic)
3. Port `graph.rs` (DAG build + cycle detection with petgraph)
4. Port `forward.rs` + `backward.rs` + `floats.rs` (CPM passes)
5. Create shared fixture suite, validate Python ↔ Rust parity
6. Implement `incremental.rs` (subgraph extraction for `incremental_update`)
7. Integrate into `cpmWorker.ts` with WASM/TS fallback
8. Add CI job: `wasm-pack build` + `wasm-pack test` + conformance check
9. Performance benchmarks against 5,000-task fixture

---

## Amendment — 2026-04-13 (Issue #19 reopen)

### Context

Issue #19 originally required the Schedule view drag-preview worker to load the Rust WASM
scheduler via `wasm-pack`. Implementation shipped with a native-TypeScript CPM in the
worker (`packages/web/src/workers/cpmEngine.ts`) — no WASM import. The Rust WASM build
exists at `packages/wasm-scheduler/pkg/` and its conformance suite
(`packages/scheduler/tests/test_wasm_conformance.py`) is green, but it is not loaded
by the web client.

VoC panel near-tie (Path A 4.8, Path B 5.0): no persona blocks on the implementation
language, and no customer has filed a perf complaint on the current drag-preview
path. Rewriting a working worker without a driver fails the decision-framework
priority "fewer moving parts = better."

### Decision — partial acceptance

1. **Rust WASM remains the conformance reference.** The Python ↔ Rust equivalence
   suite stays green and is the correctness guard for any future client-side CPM work.
2. **Drag-preview worker stays native TypeScript for now.** No code change to
   `cpmEngine.ts` or `cpmWorker.ts`. Original ADR's "Integration points: Web" section
   is **not executed in the current release** — it is held for a future migration
   triggered by a scale complaint or offline-mobile scheduling (#26).
3. **Performance regression guard added.** New Playwright spec drags a 1000-task
   fixture and asserts preview-bar frame cost ≤ 33ms p95 (≥30fps). Drives the
   decision on when Path B becomes necessary.
4. **Mobile (#26) still targets WASM via JSI.** The original integration plan for
   mobile is unchanged; mobile does not inherit the web's native-TS shortcut.

### Scope of this amendment

- No code changes.
- ADR status moves from Proposed → Accepted (partial).
- Issue #19's AC is amended to match the shipped native-TS path; Pyodide/WASM
  language is removed from the OSS web-drag-preview AC.

### Migration path (when a complaint arrives)

The original ADR's migration plan (feature-detection + WASM preferred + TS fallback)
is preserved verbatim. Trigger conditions for executing it:

- A customer reports drag-preview jank on projects > 2,000 tasks, OR
- #26 (offline mobile) ships and needs WASM in the JSI bridge anyway — at which
  point shipping the same WASM to web is marginal cost, OR
- Playwright perf guard starts failing.

### No-regression surface

- `cpmWorker.ts`, `cpmEngine.ts`, `createCpmWorker.ts`, `useDragCpm.ts` unchanged
- Preview overlay (10-bar cap, CP badge, Esc-to-cancel) unchanged
- `useKeyboardReschedule` keyboard parity unchanged
- `packages/wasm-scheduler/` build + conformance CI unchanged

