# ADR-0370: Reject Start-to-Start / Start-to-Finish Dependencies From Summary Tasks

## Status
Accepted

## Context

ADR-0024 §3 established that summary tasks may participate in the dependency graph
(phase-to-phase links), and that summary dependencies are expanded to leaf-task
edges before the CPM pass by `expand_summary_dependencies()` in the scheduler
package. The implemented expansion fans a summary edge out to the **cross product
of both endpoints' leaves**, carrying the original dependency type onto every
produced edge.

That cross-product is correct for links anchored on a summary's **finish**:

- **FS from a summary** (`S —FS→ T`): the summary's finish is its
  *latest*-finishing leaf. Fanning out to `leaf —FS→ T` for every leaf makes `T`
  wait for `max(leaf finishes)` = the summary's finish. Correct.
- **FF from a summary** (`S —FF→ T`): same — `T`'s finish is bound to
  `max(leaf finishes)` = the summary's finish. Correct.

It is **wrong** for links anchored on a summary's **start**. Per ADR-0024 §3 and
MS Project semantics, a summary's *start* is its *earliest*-starting leaf. But the
cross-product preserves the dep type, so:

- **SS from a summary** (`S —SS→ T`): fanning out to `leaf —SS→ T` for every leaf
  binds `T`'s start to `max(leaf starts)` — the summary's **latest**-starting leaf,
  not its earliest. CPM's `max()` over predecessors turns the intended "start when
  the phase starts" into "wait for the last leaf of the phase to start."
- **SF from a summary** (`S —SF→ T`): the predecessor's start likewise drives the
  successor's finish, and is over-constrained by the same last-leaf anchoring.

### The bug (#1854, High severity, verified)

For a summary `S = { S1 (10d) —FS→ S2 (1d) }` with `S —SS→ T`, the correct result
is that `T` starts when `S1` starts (the summary's start). The cross-product
instead makes `T` wait for `S2`'s start — up to the summary's whole internal span
later (10 working days in the worked example). The over-constraint is silent: the
schedule is internally consistent, just wrong, and the error scales with how long
the summary's internal chain is. Real recalculations route through this function
(`apps/scheduling/tasks.py` project recalc, `apps/projects/program_schedule.py`
program recalc), so the mis-scheduling reached production schedules.

The reachable, high-impact case is **SS/SF where the summary is the predecessor**.

## Decision

**Reject an SS or SF dependency whose predecessor is a summary task**, with an
actionable error, rather than expand it. `expand_summary_dependencies()` raises
`InvalidScheduleInput`:

```
Start-to-Start/Start-to-Finish dependency from summary task '<id>' is not
supported (ADR-0024); link to a specific leaf task instead.
```

FS and FF from a summary keep their existing (correct) cross-product fan-out.

This matches **MS Project's own restriction posture**: MS Project does not allow
SS/SF links on summary tasks. Rejecting is the smallest, safest change — it needs
no new anchoring logic, adds no synthetic graph nodes, and keeps the two engine
implementations trivially in lockstep (see *Cross-engine consistency*).

The rejection lives **only** in the real scheduling expansion
(`expand_summary_dependencies`). The cycle-detection twin
(`_expand_edges_for_cycle_check`) stays conservative and keeps expanding every dep
type to the full cross product: cycle detection must still *see* the edges to catch
a summary that logically depends on its own descendant. Cycle checking never
consumes the (wrong) dates, so the over-constraint is irrelevant there.

### Scope

Only the **predecessor** case is rejected — the case the CPM `max()` over
predecessors actually over-constrains, and the reachable bug in #1854. A leaf
`T —SS→ S` (summary as *successor*) is left conservatively untouched: it anchors on
the successor side and is out of scope for this change.

## Alternatives Considered

| Option | What it does | Why deferred |
|--------|--------------|--------------|
| **(a) Re-anchor to the earliest leaf** | For `S —SS→ T`, emit a single `earliest-starting-leaf —SS→ T` edge instead of the cross product | "Earliest-starting leaf" is only known *after* the CPM forward pass, but expansion runs *before* it. Determining it up front requires a pre-pass or a two-phase expand/schedule loop — real added complexity and a new failure surface. Also has to be mirrored exactly in the Rust engine to stay conformant. Deferred: can be revisited if users demand SS-from-summary as a supported link. |
| **(b) Synthesize a hammock/anchor node** | Insert a zero-duration node representing the summary's start and route the SS/SF edge through it | Adds synthetic nodes to the graph that users never created, complicating result mapping, cycle detection, float attribution, and the sync/serialization surface. Heavyweight for a link MS Project itself forbids. Deferred. |
| **(c) Reject with an actionable error (chosen)** | Raise `InvalidScheduleInput` naming the summary and telling the user to link a leaf | Smallest, safest, lockstep-simple; matches MS Project. Inputs that previously scheduled *wrong* now error clearly. |

## Consequences

### What becomes easier
- Summary-anchored schedules are now correct-or-rejected — never silently wrong.
- The engine invariant is simple and MS-Project-aligned: "no SS/SF from a summary;
  link to a specific leaf."
- No new anchoring or graph-rewriting machinery to maintain across two engines.

### What becomes harder
- **Inputs that previously scheduled (incorrectly) now error.** A project with an
  existing `S —SS→ T` or `S —SF→ T` link that previously produced a schedule will
  now surface `InvalidScheduleInput` on recalculation until the user repoints the
  link at a specific leaf task. This is a deliberate, user-visible behavior change:
  a wrong schedule is replaced with an actionable error. It is a **fix**, not a
  regression — the prior output was over-constrained by up to the summary's span.
- The rule is uniform (even a single-leaf summary rejects SS/SF), so users get one
  predictable rule rather than "rejected only when the fan-out happens to matter."

### ADR-0024 alignment
This refines ADR-0024 §3's "SS/FF/SF variants — same leaf-resolution logic": the
cross-product leaf-resolution is only faithful to ADR-0024's stated anchors
(summary start = earliest leaf, summary finish = latest leaf) for the finish-anchored
types (FS/FF). For the start-anchored types *from* a summary it is not, so those are
rejected until/unless a correct re-anchoring (alternative a) is implemented.

## Cross-engine consistency

Summary dependency expansion is a **server-side (Python) preprocessing step only**.
`expand_summary_dependencies()` runs in the API recalc paths *before* a `Project` is
built for either engine; the resulting `Project` already contains only leaf tasks and
expanded leaf-level edges. The Rust/WASM engine (`packages/wasm-scheduler`) has no
summary, `children_map`, or leaf-expansion concept at all — its `Project` model does
not even carry `children_map` (`#[serde(deny_unknown_fields)]`), and the browser
recompute path expands summaries server-side via `children_map` (#360) before calling
WASM. Consequently the WASM engine never receives a summary edge, and the two engines
agree **by construction**: the invalid SS/SF-from-summary link is rejected in the
Python preprocessing step before either engine's `schedule()` / `schedule_impl()`
CPM pass runs. No Rust-side change and no shared conformance fixture is applicable,
because the shared conformance fixtures are post-expansion `Project` documents fed
directly to `schedule()` / `schedule_impl()`, neither of which invokes
`expand_summary_dependencies`.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS).
- **Affected packages**: `scheduler` (rejection in `expand_summary_dependencies`).
- **API changes**: None — same public function, one new rejected input class.
- **Migration required**: No.
- **OSS or Enterprise**: OSS (trueppm-suite).

## Tracking

Tracking: #1854.
