# ADR-0371: Typed-Array Drag-Preview Result for the WASM Scheduler

## Status
Proposed

Extends the resident-session design of **ADR (#1533)** / `SchedulerSession` and the
dense-node-order convention of **#1535**. Does not change the CPM math or the shared
Python↔Rust conformance contract (**#1505/#1506**) — the JSON entry points and their
fixtures are untouched; this ADR adds a second, columnar *output* path alongside them.

## Context

The WASM scheduler (`packages/wasm-scheduler`, Rust + petgraph, compiled with
wasm-pack) provides an in-browser/offline CPM recompute. The drag-preview flow
recalculates the schedule **every animation frame**. `SchedulerSession` (#1533)
already hoisted the parse / validate / graph-build cost out of that per-frame loop,
leaving two costs that still scale with total project size and repeat every frame:

1. **A full deep clone of every `Task`.** `compute_full` / `compute_downstream` do
   `let mut tasks: Vec<Task> = project.tasks.clone();`. Each `Task` carries two heap
   `String`s (`id`, `name`), so at 5,000 tasks that is ~10k allocations plus a
   ~1.5–2 MB copy **per frame**.
2. **Full-result JSON serialization to a `String`.** The result is `serde_json`-ed
   to a string, copied UTF-8 → UTF-16 across the boundary, then `JSON.parse`d into
   ~5,000 fresh JS objects per frame.

Realistically 5–15 ms/frame of pure overhead at 5k-task scale — the serialization
alone can blow the 16.7 ms budget before any rendering happens (#1856, HIGH sev).

A drag changes a bar's **date**, not the network **topology**: the task set, the
dependency edges, the id/name strings, and the anchor (`project.start_date`) are all
constant for the whole session. Only `planned_start` on the dragged task moves.

## Decision

Add a **columnar typed-array output path** to `SchedulerSession`, alongside (not
replacing) the existing JSON `recalc` / `recalc_incremental`. Three changes:

### 1. Session-resident scratch buffer (no per-frame clone)

`SchedulerSession` gains `scratch: RefCell<Vec<Task>>`, cloned from `project.tasks`
**once** in the constructor. Each frame, `sync_inputs` refreshes only the `Copy`
input fields (`duration`, `planned_start`, actuals, PERT estimates, …) from the
resident project into the scratch — the per-task `String`s (`id`, `name`) and the
constant `Option<String>` fields (`calendar_id`, `delivery_mode`) are **never
re-cloned**. The three CPM passes then overwrite every computed field, so no stale
value from the previous frame can leak. `RefCell` because the recalc methods take
`&self` (the session's observable state — the project — is unchanged by a recalc)
while needing to write the scratch's computed fields.

### 2. Typed-array output instead of a JSON string

The result crosses the boundary as columns, not a serialized object graph. A
`DragResult` (wasm-bindgen struct) exposes:

| Column          | JS type        | Encoding                                             |
|-----------------|----------------|-----------------------------------------------------|
| `nodeIndices`   | `Uint32Array`  | dense node position of each row                     |
| `earlyStart`    | `Int32Array`   | day ordinal relative to the session epoch           |
| `earlyFinish`   | `Int32Array`   | day ordinal relative to the session epoch           |
| `lateStart`     | `Int32Array`   | day ordinal relative to the session epoch           |
| `lateFinish`    | `Int32Array`   | day ordinal relative to the session epoch           |
| `totalFloat`    | `Float64Array` | **seconds** (parity with the JSON `TaskResult`)     |
| `freeFloat`     | `Float64Array` | **seconds**                                         |
| `isCritical`    | `Uint8Array`   | 1 = on critical path, else 0 (one byte per row)     |
| `projectStart`  | `i32` scalar   | day ordinal relative to the session epoch           |
| `projectFinish` | `i32` scalar   | day ordinal relative to the session epoch           |

Handing back numeric `Vec`s copies one contiguous buffer per column into a JS typed
array — cheap next to `serde_json` + `JSON.parse` of thousands of objects, with no
UTF-8/16 transcode and no per-task JS object allocation.

Encoding choices:
- **Dates as `i32` day ordinals relative to a session epoch** (`project.start_date`).
  The epoch crosses to JS **once** (`SchedulerSession.epoch`, ISO string). JS
  reconstructs a date as `epoch + ordinal` days. `num_days_from_ce` differences are
  exact and fit `i32` for any date the validator admits.
- **Floats in seconds, not days** — matching the JSON `TaskResult` unit exactly, so
  the two output paths are bit-for-bit comparable (the correctness-parity test) and
  the JS side keeps its existing `/86400` conversion.
- **`isCritical` as `Uint8Array`** (one byte/task) rather than a packed bitset —
  ~5 KB at 5k tasks (negligible) and no bit-unpacking on the JS side. The issue
  explicitly permits either.

### 3. Index by stable dense node order; ids cross once

All columns are indexed by **row**. `nodeIndices[row]` is the task's stable dense
node position (nodes are added in `project.tasks` order, #1535). Task ids cross the
boundary **once** per session via `SchedulerSession.taskIds()` (dense node order); a
row maps to its id as `taskIds()[nodeIndices[row]]`. For a **full** recalc
`nodeIndices` is `0..N`; for the **incremental** (downstream-only) recalc it is the
subset of nodes reachable from the dragged task — so `nodeIndices` **is the
delta-emit**, and only changed tasks are materialized in the columns.

### Critical-path ordering dropped from the per-frame path

The JSON result includes an ordered `critical_path: Vec<String>`, produced by
`lexicographical_topo_order`, which is keyed by `(early_start, id)` and therefore
**data-dependent** — it genuinely changes as `early_start` shifts during a drag, so
it cannot simply be cached across frames. Rather than cache it, the typed path
**omits the ordered critical path entirely**: a drag preview only needs to know
*which* tasks are critical (the `isCritical` bitset carries that per task), not their
ordered sequence. This removes the `lexicographical_topo_order` Kahn sort from the
per-frame path completely (satisfying the issue's "avoid rebuilding the order every
frame" goal by elimination rather than caching). The structural topological order
(`pg.topo_order`) used by the passes was already built once at session creation and
is reused unchanged. A consumer that needs the ordered critical path (e.g. the
post-commit authoritative view) uses the JSON `recalc`, which is off the hot path.

## Consequences

- **Per-frame allocation drops from ~10k to ~0 for the task set** (scratch is
  resident), plus a handful of contiguous numeric `Vec`s for the output columns.
  JSON serialize + parse is eliminated on the drag path.
- **The boundary contract for the drag path changes from a JSON string to columnar
  typed arrays.** The JSON `recalc` / `recalc_incremental` methods and the stateless
  `compute_schedule` / `wasm_incremental_update` functions are **unchanged**, so the
  conformance oracle and any JSON consumer keep working. The typed path is additive.
- **No web consumer is wired to the WASM scheduler yet.** The current in-browser
  drag preview uses the pure-TypeScript engine in `packages/web/src/workers/`
  (`cpmEngine.ts`), not this WASM module. When the WASM path is adopted, the JS
  wrapper reads `taskIds()` and `epoch` once at `DRAG_START`, then per frame reads
  the `DragResult` columns and maps `row → id` via the cached ids — no per-frame id
  or date-string handling. Documenting the contract here is the prerequisite for
  that wiring.
- **Delta-emit is implemented** for the incremental path via `nodeIndices` (only
  downstream rows are materialized). Whole-project aggregates (`projectStart` /
  `projectFinish`) are still computed over the full task set, matching the JSON path.

## Alternatives considered

- **Cache `lexicographical_topo_order` across frames** — rejected: the order depends
  on `early_start`, which the drag mutates, so it is not cacheable. Dropping the
  ordered critical path from the preview is simpler and strictly cheaper.
- **wasm-bindgen memory views (`js_sys::Int32Array::view`) into the scratch** —
  rejected: views are invalidated on any Wasm heap realloc and impose an unsafe
  lifetime contract on the JS caller. Returning owned `Vec`s (one memcpy per column)
  is safe and still far cheaper than JSON.
- **Packed bitset for `isCritical`** — deferred: negligible size win at this scale,
  extra unpack complexity on JS.
