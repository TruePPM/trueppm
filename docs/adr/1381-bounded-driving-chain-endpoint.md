# ADR-1381: Bounded driving chain for a task — one call, summary edges expanded server-side

- **Status:** Accepted (2026-11-09; provenance option B chosen by the user)
- **Date:** 2026-11-09
- **Issue:** #4891 (epic #4889)
- **Related:** ADR-0218 (schedule value derivation), ADR-0112 (signed-answer provenance), ADR-0105 (summary strip), #2642 (`stamp_answer` does not exist), #4656 (uncapped `critical_path` lists), #3602 (client walkers blind to summary-gated edges)

## Context

`GET /projects/<pk>/schedule/derivation/` (ADR-0218) explains one hop of one quantity.
"Why is this task critical" needs the chain to the project finish and back to the
anchor: N calls today, each a full `schedule()` pass under `cpm_on_read`. A client that
walks the chain itself re-implements ADR-0105's summary expansion and gets
summary-gated edges wrong (#3602).

The engine already produces everything needed in one pass:
`ScheduleResult.driving_edges` (`DrivingEdge`: predecessor, successor, dep_type — the
union of binding links and zero relationship-free-float links, #4704), per-task
`total_float` / `is_critical`, and `project_finish`. The API's `build_sched_graph`
already applies `expand_summary_dependencies`, and keeps the `children_map` and the
raw (pre-expansion) dependency list, so whether a leaf edge came from a summary link is
derivable API-side. **No scheduler change is required.**

## Decision (settled parts)

1. **Endpoint:** `GET /projects/<pk>/schedule/driving-chain/?task_id=<id>[&depth=<n>]`,
   operation id `project_schedule_driving_chain`. Same view posture as
   `ScheduleDerivationView`: `McpReadableViewMixin`, `mcp_scope = PATH`,
   `project_url_kwarg = "pk"`, `[IsAuthenticated, IsProjectMember, IsProjectNotArchived]`,
   404 for a non-member, `mcp_compute_heavy = True`, `throttle_scope = "cpm_on_read"`.
   Input built by the shared `_build_cpm_sched_project`, so it explains the same
   network `_run_schedule` persisted.
2. **One pass:** a single `schedule()` call; the chain is walked over
   `driving_edges` in the API layer.
3. **Walk:** upstream from the task along driving predecessors to tasks with no
   driving predecessor (the anchor set); downstream along driving successors to tasks
   with no driving successor (the finish set; a node finishing on `project_finish` is
   flagged `is_project_finish`). Breadth-first, deterministic order (sorted ids), each
   node visited once — the graph is a DAG after `schedule()` validates it, so the
   result is cycle-free by construction.
4. **Bounds:** `depth` default 25, max 50 (hops per direction); hard node cap 200 per
   response. Either limit sets `truncated: true` plus `truncated_reason`
   (`depth` | `node_cap`). No uncapped id list anywhere in the payload (#4656).
5. **Node:** `task_id`, `name`, `status`, `total_float_days`, `is_critical`,
   `is_project_finish`, `sprint` (`{id, finish_date}` or `null`). **No assignee, hours or
   velocity** — the sprint field states only that the node is sprint-bound and when the
   sprint ends.
6. **Edge:** `predecessor_id`, `successor_id`, `dep_type`, `lag_days`, `is_driving`
   (always true for an emitted edge in this version; kept so a later "near-driving"
   widening is additive), `via_summary` (`null`, or the summary id(s) the leaf edge was
   expanded from). An edge that is both a direct link and a summary fan-out reports the
   direct link (`via_summary: null`) and the merged lag the engine used.
7. **Not computable:** a task CPM does not cover returns 200 with
   `{computable: false, reason: "backlog" | "not_committed" | "summary" | "not_in_network"}`
   and no chain — never a fabricated one. Unknown task id → 404 (same as derivation).
8. **MCP:** `get_schedule_driving_chain(project_id, task_id, depth?)` in
   `packages/mcp/src/trueppm_mcp/tools.py`, mirroring `_get_schedule_derivation`,
   returning the server payload unchanged.

## Provenance (decided 2026-11-09: option B)

The issue requires the response be "routed through `stamp_answer` so the `_provenance`
envelope is attached", and the acceptance criteria require `_provenance` on the MCP
response. **`stamp_answer` and `apps/provenance/` do not exist** (#2642, open,
`release::stretch`). ADR-0218 deliberately shipped the derivation unstamped and
deferred a uniform envelope so it would "land once, consistently, not be introduced
piecemeal". Options:

- **A. Build `stamp_answer` here** (ADR-0112 §2: `apps/provenance/services.py`,
  canonical input hash, `signed_answer_emitted` signal). Resolves #2642's option 1, but
  adds a new app (app-layering assignment), a new OSS↔Enterprise extension signal
  (triggers `threat-model`, a stable-shape commitment to Enterprise), and roughly
  doubles the branch. #2642 is stretch; #4891 is committed.
- **B. Minimal local envelope** — `_provenance: {engine_version, input_hash,
  computed_at}` from a small helper (reusing `agents.services.engine_version()`), no
  signal, no new app; #2642 later adopts or replaces it. Fast, but is exactly the
  piecemeal introduction ADR-0218 rejected, and fixes a shape before #2642 decides it.
- **C. Ship unstamped** like ADR-0218, amending #4891's criterion; the chain payload is
  its own derivation. Consistent with every other computed read today; fails the
  issue's stated criterion and the panel blocker "bounded contract with provenance".

**Decision: B.** The response carries `_provenance` with the ADR-0112 §2.1 shape verbatim — `schema_version` (1), `engine_version`, `api_version`, `input_hash` (`sha256:` over the canonical JSON of the scheduler `Project.to_dict()` the pass received: sorted keys, no insignificant whitespace), `computed_at` (UTC ISO-8601). `actor` is omitted, as in the §2.1 JSON example. `engine_version` reads `trueppm_scheduler.__version__` with the same `"unknown"` fallback as `agents.services.engine_version()`, rather than importing it: `scheduling` is a core-layer app and `agents` a satellite, so the import would be an upward edge that `api:app-layering` rejects (`packages/api/app-layering.toml`). #2642 consolidates both copies when the helper moves to a platform-level home. The helper is `stamp_answer(payload, *, engine_inputs)` in `apps/scheduling/answer_stamp.py` — the ADR-0112 signature minus `actor` — with **no new app and no `signed_answer_emitted` signal**, so no new OSS↔Enterprise extension point is created and `threat-model` stays n/a.

- **A rejected:** building `apps/provenance/` and the signal here would pull the stretch issue #2642 into a committed one, add a stable-shape Enterprise hook without its own threat model, and roughly double the branch.
- **C rejected:** shipping unstamped fails the issue's acceptance criterion and the panel blocker "bounded contract with provenance".
- **Cost accepted:** this is the piecemeal introduction ADR-0218 warned against. It is contained by copying the §2.1 shape exactly, so #2642 adopts (moves) this helper rather than competing with it; when #2642 lands, `stamp_answer` moves to `apps/provenance/services.py` and gains `actor` and the signal, with no wire change.

## Consequences

- One round trip and one CPM pass replace N; summary expansion stays a server fact.
- The chain is a bounded view, not a network diagram (epic out-of-scope).
- `driving_edges` includes zero-free-float links that do not bind (#4704), so a merge
  can show two driving predecessors; the payload says so rather than picking one.
