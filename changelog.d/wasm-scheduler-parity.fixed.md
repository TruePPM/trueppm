- **WASM scheduler validation parity with Python (#1085, #1086, #1087)**: the
  Rust/WASM engine now rejects the same degenerate input the Python engine does,
  closing three cross-engine accept/reject divergences. A complete three-point
  estimate with `most_likely` outside `[optimistic, pessimistic]` is rejected
  (#1085); a `planned_start` (SNET) pinned more than `MAX_PROJECT_SPAN_DAYS` after
  the project start is rejected, and the furthest pin's offset is added once to
  the cumulative span bound (#1086). Two reachable panic paths — a dependency that
  references an unknown task, and an incremental update with a stale
  `changed_task_id` — now return a clean error instead of trapping the WASM module
  (#1087); the Python engine raises `InvalidScheduleInput` (was a bare
  `ValueError`) for the unknown-dependency case so both engines reject the shared
  conformance fixtures identically.
