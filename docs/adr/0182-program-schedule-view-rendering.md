# ADR-0182: Program schedule view — rendering the cross-project critical path (ADR-0120 §D6 implementation)

## Status
Accepted — addendum to ADR-0120 (§D6)

## Context

ADR-0120 §D6 calls for a `ProgramSchedulePage` (#1118) that renders the
**merged, program-true** schedule of a Program's member projects: project-lane
grouping, cross-project dependency arrows, and the program-true critical path
highlighted across lanes. This is the visual payoff surface for the GA-launch
sample-program demo.

The data substrate already shipped on `main`: the read endpoint
`GET /api/v1/programs/{id}/schedule/` (ADR-0120 D3 *read side*, commit
`a362ecc54`) computes the merged CPM on read and returns lane metadata, leaf
tasks (full or redacted to the D5 `ExternalTaskCard` shape), leaf-level links
flagged `is_cross_project`, and the program-true `critical_path`. The
contract — verified against the merged source — is:

```
{ program_id, start_date, finish_date,
  projects: [{ id, name, accessible }],                       // lanes
  tasks:    [ full     {id,name,hex_id,project_id,is_milestone,is_external:false,
                        wbs_path,early_start,early_finish,late_start,late_finish,
                        total_float_days,is_critical}
            | redacted {id,title,hex_id,project_id,project_name,is_milestone,
                        is_external:true,early_start,early_finish,is_critical} ],
  links:    [{predecessor_id,successor_id,dep_type,lag_days,is_cross_project}],
  critical_path: [task_id, …],
  cross_project_edge_count }
```

The **empty case** (no member project has scheduled work) is **not** an error —
the endpoint returns `200` with an empty payload (`tasks: []`, `start_date:
null`, lanes still listed), which the page renders as the empty state. Genuine
errors are `422` (`ProgramScheduleTooLarge`, >5000 tasks) and `403` (non-member).
Permission: any program member (`IsProgramMember`, closed programs stay
readable); tasks in member projects the caller cannot read come back redacted.
This is a **render-don't-derive** source (ADR-0115): the browser runs no program
CPM — it draws the server's authoritative output.

This feature is **frontend-only**; no API, model, or migration change. The
question this ADR settles is *how* to render the merged schedule in the existing
canvas Gantt engine without a rewrite.

The forces:

- **No engine rewrite (ADR-0120 §D6, ADR-0030).** ADR-0030 explicitly requires
  the program/overview schedule surfaces to reuse the existing `GanttRenderer`
  "in a constrained/read-only mode, not a new library." The engine
  (`packages/web/src/features/schedule/engine/`) is a *versioned* public contract
  (`GanttEngine.ts`); breaking changes require an ADR and lockstep updates to
  `GanttEngineImpl` + `GanttEngineStub`.
- The engine is **stateless and scope-unaware** (ADR-0014, ADR-0056, ADR-0063):
  `drawDependencyArrows` / `prepareDependencyLayout` draw whatever flat
  `Task[]`/`TaskLink[]` array they receive; arrow routing already spans arbitrary
  row distances.
- The engine has **no lane / row-grouping model** today. It *does* already render
  **summary-task hierarchy** — `isSummary` rows with indented `parentId` children.
- The program payload contains **leaf tasks only** (the endpoint expands summary
  tasks away). So there is no within-project summary hierarchy to preserve in the
  program view — every task is a leaf.
- This is the **GA-demo centerpiece**; destabilizing the shared engine immediately
  before GA is a risk to weigh heavily.

## Decision

Render the program schedule in the **existing canvas engine** (Option A), using
the lowest-risk realization that requires **no change to the versioned engine
row-model or `GanttEngine` interface**:

1. **Project lanes = synthetic per-project summary rows.** The
   `ProgramSchedulePage` transforms the payload into engine `Task[]`/`TaskLink[]`:
   for each `projects[]` lane it synthesizes a summary `Task`
   (`id = "lane:{projectId}"`, `name = project.name`, `isSummary: true`,
   `parentId: null`, span = min/max of its children's dates), and reparents every
   leaf task under its lane (`parentId = "lane:{task.project_id}"`). The engine's
   existing summary rendering, indentation, and collapse/expand then produce lane
   grouping **for free**. Synthetic non-entity rows are an established pattern
   (ADR-0115's "Project Tasks" root lane); they carry no progress chip and do not
   open a task drawer (the page ignores `task-open` on `lane:` ids).

2. **Cross-project arrows** via one **additive optional** field
   `TaskLink.crossProject?: boolean`, mapped straight from the server's
   `is_cross_project` (render-don't-derive — the server decides cross-project-ness,
   not the client). The connector is drawn **dashed** (the path drawer gains an
   optional `lineDash`); it keeps the **charcoal** arrow color like every other
   connector, because ADR-0063 rule 73 reserves arrow color for nothing — only the
   dash distinguishes a cross-project handoff. This deliberately adds **no new
   color** (the Design System v2 token ratchet forbids new raw hex; the dash is
   the color-blind-safe signal anyway). Existing single-project callers omit the
   field → unchanged behavior.

3. **External (redacted) tasks** via one **additive optional** field
   `Task.isExternal?: boolean`, mapped from the payload's `is_external`. Such bars
   reuse the existing muted **secondary-text** color plus a diagonal hatch
   (`barFillColor`/`drawTaskBar` branches) so the access boundary is visible
   without a new token; criticality shows as a red **outline**, never a red fill.
   The page renders only a **minimal hover card** (title, project_name, dates) for
   them — never description, assignee, status, or points (ADR-0120 D5). External
   tasks are positioned by their program-true CPM dates, which the redacted payload
   still includes.

4. **Live updates** reuse the per-project channel (no program channel in 0.3, per
   ADR-0091) via a small, **isolated** `ProgramScheduleLiveSync` component: it
   mounts one purpose-built socket per member project that invalidates
   `['programs', programId, 'schedule']` on schedule-affecting events. It is
   deliberately **not** `useProjectWebSocket`: that hook writes the shared
   scheduler/task-run/presence stores, which would surface a spurious global
   "tasks running" indicator on the program page from another project's recalc.
   The isolated socket touches no global store.

Every engine touch is **additive and optional**, keyed off a server-authoritative
flag, and leaves the `GanttEngine` interface and all existing call sites
byte-compatible — no new design-system token or raw hex is introduced. This is
therefore an *extension*, not a breaking change to the versioned contract; this
ADR records it per the ADR-0063/0066 convention.

### Scope (v1)

- New `Schedule` tab on `ProgramTabs` + `/programs/:programId/schedule` route +
  lazy-loaded `ProgramSchedulePage`.
- `useProgramSchedule(programId)` hook (query key `['programs', id, 'schedule']`),
  explicit TS types for the inline endpoint response.
- Transform → engine `Task[]`/`TaskLink[]` with synthetic lanes; read-only mount
  (no drag/resize/create-link wiring).
- Program-true critical path (red bars across lanes), cross-project dashed arrows,
  external redacted bars + minimal hover card.
- Loading skeleton, empty state (the `200` empty payload — no scheduled work),
  error states (`422` too-large, `403` non-member), per-project live invalidation.
  (A `409` is also handled defensively, though this endpoint does not emit one.)
- Three-layer tests + `docs/features/` page + changelog fragment.

### Out of scope (deferred — no backend on `main`)

- **`CrossProjectSlipConflict` badge + acknowledge flow.** No model exists on
  `main` (`grep CrossProjectSlipConflict packages/api/src` → none); its creator is
  the deferred D3 *dispatch* pass. Designing frontend for a nonexistent backend is
  rejected.
- **Pending-edge dashed render + accept/reject affordance.** The schedule endpoint
  *excludes* pending edges (`.exclude(pending_acceptance=True)`) and there is no
  program-scoped feed listing pending cross-project edges. A per-dependency
  `POST .../accept` exists but nothing to enumerate pending edges for rendering.
  Deferred to the issue that ships that feed.

Both cuts are consistent with ADR-0120's "Implementation note — D3 read surface
lands first": the persisted dispatch/conflict machinery is explicitly deferred.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A (chosen): existing engine, synthetic-summary lanes + additive flags** | No engine row-model rewrite; no `GanttEngine` interface break; reuses summary/indent/collapse rendering; render-don't-derive; lowest risk before GA; satisfies ADR-0030/§D6 "no new library" | Lanes are summary rows, not dedicated lane *bands* (weaker visual separation than a bespoke lane model); synthetic rows need `task-open` suppression |
| A1: true lane model in the engine (lane bands + lane header rows) | Strongest lane visuals | ~100–150 LOC across `GanttRenderer`+`GanttEngineImpl`; touches versioned contract; deeper test surface; destabilizes shared engine right before GA |
| B: separate read-only program-timeline renderer reusing only scale primitives | Full layout freedom | Directly contradicts ADR-0030 ("not a new library") and §D6 ("no engine rewrite"); duplicates bar/arrow/critical-path rendering → drift risk; abandons render parity with the project Gantt |
| C: render program schedule as a table/list (no Gantt) | Trivial | Fails the entire point — the cross-project critical path *across lanes* is the visual centerpiece |

A1 remains the natural follow-up if product wants dedicated lane bands after GA;
this ADR deliberately defers it to keep the GA centerpiece low-risk.

## Consequences

- **Easier:** ships the §D6 centerpiece with a tiny, additive, well-bounded engine
  delta; render parity with the project Gantt is preserved (same bars, same
  critical-path treatment); the access boundary is visually honest.
- **Harder:** lane grouping is expressed through the summary mechanism, so a future
  dedicated lane-band model (A1) would re-home the grouping; synthetic `lane:` ids
  are a convention the page must guard in event handlers and tests.
- **Risks:** (1) cross-project arrow routing across distant lanes is exercised far
  more here than in single-project views — covered by E2E and by seeding
  `plannedStart` from `early_start` so program tasks anchor their arrows;
  (2) the isolated live-sync subscriber opens one socket per member project —
  mitigated by per-project cleanup (timers + socket closed on unmount/projectIds
  change) and by writing no global store; (3) the `422` too-large limit and the
  `200`-empty payload are program-scale/empty realities the page must handle
  gracefully, not just the golden path.

## Implementation Notes

- **P3M layer:** Programs and Projects → **OSS**. A program spanning member
  projects, managed by one PM/team, is the core OSS adoption unit (CLAUDE.md
  Two-Repo Rule; `Program` is OSS). Cross-*program*/portfolio rollups would be
  Enterprise — this is strictly within one program.
- **Affected packages:** `web` only.
- **Migration required:** no.
- **API changes:** none (consumes the shipped `GET /programs/{id}/schedule/`).
- **OSS or Enterprise:** OSS. `grep -r trueppm_enterprise packages/web/src` → no
  imports (one boundary-comment only). No enterprise hook touched.
- **Engine contract delta (additive, non-breaking):** `TaskLink.crossProject?`,
  `Task.isExternal?`, and an optional `lineDash` in the arrow path drawer.
  `GanttEngine` interface and all existing call sites unchanged. No change to
  `useProjectWebSocket` — live sync is the isolated `ProgramScheduleLiveSync`
  component. No new design-system token or raw hex (the v2 ratchet stays flat).

### Durable Execution
1. **Broker-down behaviour:** N/A — the program schedule view is a pure read
   surface (one `GET`, compute-on-read server side). It dispatches no async work,
   so there is no broker-dispatch path to harden.
2. **Drain task:** N/A — no async work enqueued.
3. **Orphan window:** N/A — no outbox rows written.
4. **Service layer:** N/A — read-only; no mutation service. (The server endpoint
   already encapsulates the CPM computation.)
5. **API response on best-effort dispatch:** N/A — synchronous `200` read; no
   best-effort dispatch.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** N/A for writes; reads are naturally idempotent. The
   compute-on-read endpoint is deterministic for a given project state, so repeated
   fetches (e.g. WS-triggered invalidations) are safe and side-effect-free.
8. **Dead-letter / failure handling:** N/A — a failed read surfaces as a query
   error in the page (`403`/`422`/network), rendered as an inline error (with a
   retry for network/5xx) or, for the `200`-empty payload, the empty state;
   nothing is queued or retried server-side.
