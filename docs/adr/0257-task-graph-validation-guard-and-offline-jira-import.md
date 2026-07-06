# ADR-0257: Shared task-graph validation guard (#1665) + offline Jira import (#1664)

## Status
Accepted

## Context

Two coupled OSS backend gaps surfaced in the 2026-07-06 ranked-priorities audit. User
priority is settled; this ADR only fixes the design.

**#1665 — write-path validation parity.** Cycle and self-reference detection live in
exactly one place: `DependencySerializer._check_no_cycle` (`projects/serializers.py:4120`),
which calls the single-source-of-truth `trueppm_scheduler.find_cycle(edges, children_map=…)`
(`scheduler/engine.py:600`) and raises `CycleDetectedError` (`serializers.py:3475`) →
`400 {"detail":"cyclic_dependency","cycle":[…]}`. Every **bulk** writer bypasses this
entirely: the MSP importer `bulk_create`s dependencies with no validation
(`msproject/importer.py:229`), and inbound sync creates tasks only, no deps
(`inbound_sync.py:233`). An agent or importer can therefore persist an infeasible network
that the CPM engine then chokes on. The interactive (human) path validates; the bulk/agent
paths do not — that asymmetry is the bug.

Two code facts constrain the fix. `find_cycle` is already the shared algorithm — the parity
that matters (the cycle math) is guaranteed the moment every path funnels through it. And
the serializer's single-edge logic carries concerns a bulk guard must **not** inherit:
cross-project consent (`_resolve_cross_project_consent`, needs `request.user`),
program-merged cycle scope (ADR-0120 D1), and `instance`-exclusion on update. Those are a
permission/serializer responsibility and stay put. The bulk guard is **intra-project** and
principal-agnostic.

**#1664 — Jira → CPM-schedulable network.** MSP import is today the only path that produces
a computable network. A team that lives in Jira has no way in. Per ADR-0097 this must be the
**user-scoped, one-way, read-only** shape (OSS), not the org connector (Enterprise). An
**offline file import** — no host, no OAuth, no webhook, no writeback — is the cleanest
possible fit for that carve-out and sidesteps SSRF/auth entirely. It also structurally
depends on #1665: an import that fabricates a whole dependency network must validate it
before persisting, using the same guard the agent write path uses.

## Decision

### #1665 — the guard

**Placement.** New module `apps/scheduling/graph_guard.py`, alongside `enqueue_recalculate`
in the scheduling domain (where "what makes a schedule computable" belongs), not in
`projects/serializers.py` (import-cycle risk; wrong domain).

**Signature.**
```
validate_task_graph(edges, *, children_map=None) -> None
```
- `edges`: the **complete** edge set of the network under validation, as
  `list[tuple[str, str]]` of `(predecessor_pk, successor_pk)`. Importers already hold every
  task/dep in memory, so no DB round-trip is needed — the caller passes what it is about to
  persist.
- `children_map`: the summary→leaf expansion map (same shape `find_cycle` consumes), built
  in-memory from the imported tasks.
- Behavior: (1) self-reference — any `pred == succ` edge; (2) cycle —
  `find_cycle(edges, children_map=children_map).cycle`. On a hit, raise `InfeasibleGraphError`.

**Exception.** `InfeasibleGraphError(reason, offending)` defined in the same module:
`reason ∈ {"self_reference","cyclic_dependency"}`, `offending` = the offending edge (self-ref)
or the `find_cycle` cycle path. Deliberately **not** a DRF `ValidationError` — it is a
domain signal each caller renders in its own vocabulary (importer → TaskRunTracker result
field; a future viewset → the existing `{"detail":"cyclic_dependency","cycle":…}` shape).

**Serializer stays as-is (lowest-risk parity).** We do **not** refactor
`_check_no_cycle` to route through the guard. Both paths already share the one thing that
must be identical — `find_cycle` — so wrapping it in the guard for bulk callers achieves
parity without disturbing the serializer's consent/program-scope/instance logic. Self-ref is
a two-line identity check, trivially identical on both sides. (A later, optional refactor can
have the serializer delegate its self-ref + `find_cycle` core to the guard; it is not needed
for correctness now and carries regression risk on the interactive path.)

**Importer surfacing — reject the network, quarantine the trivial.** Two failure classes:
- **Self-loop** (Jira/MSP data glitch, never changes feasibility): quarantine — skip the edge
  and append a `summary["warnings"]` entry, exactly as MSP already does for a missing
  predecessor (`importer.py:215`). The guard raising on self-ref is used pre-`bulk_create`
  only after such loops have been filtered, or the importer filters them first and never
  passes them in.
- **Genuine cycle**: **reject the whole import atomically.** A cyclic source file is
  malformed; silently dropping "some edge" to break the cycle would guess user intent and
  produce a schedule that doesn't match the source. The import transaction aborts, the
  `ImportRequest` ends DEAD/failed, and TaskRunTracker records the structured cycle path so
  the user sees *which* tasks form the loop. This is the AC's "never persist an infeasible
  network."

**Call site.** In both importers, immediately **before** `Dependency.objects.bulk_create`,
inside the existing `transaction.atomic()`: build `edges` from the assembled `dep_objects`
and `children_map` from the imported tasks, call `validate_task_graph`, let
`InfeasibleGraphError` propagate to abort.

**Parity regression test (AC).** inbound sync creates no deps, so dep-validation parity there
is vacuous — nothing to guard. The parametrized parity test therefore targets the existing
`DependencyViewSet.create` endpoint: post an identical **cyclic** payload once as an
**API-token** principal (agent) and once as a **JWT session** (human), asserting *identical*
`400 {"detail":"cyclic_dependency", "cycle":…}` and identical allow/deny. This proves the
write path validates the same regardless of auth principal — the property the audit flagged.
The new `graph_guard` gets its own unit tests (self-ref, simple cycle, summary-expanded
cycle, clean graph) plus an importer integration test feeding a cyclic file and asserting the
whole import is rejected with the cycle surfaced.

### #1664 — Jira import

**Transport: offline Jira XML export (option b) — confirmed.** Read a file the user exports
from Jira (Server/DC: *Export → XML* on a filter/JQL result, the RSS-style
`<rss><channel><item>…` document). XML is chosen **specifically because it carries
`<issuelinks>`** — the dependency edges are the whole point of importing into a CPM engine,
and CSV export does not cleanly carry them. No network call, no OAuth, no host resolution →
no SSRF surface, and squarely inside the ADR-0097 personal/read-only/one-way carve-out (OSS).

**Fields read, per `<item>`:**
- `<key>` (e.g. `PROJ-123`) — the external key for the two-pass map (see below).
- `<summary>` — task name.
- `<timeoriginalestimate seconds="N">` — read the **`seconds` attribute** (the element text
  is a human string like "1 day"). Missing/zero → default 1 day.
- `<issuelinks>` → `<issuelinktype>` with `<name>Blocks</name>`, holding
  `<outwardlinks description="blocks">` and `<inwardlinks description="is blocked by">`, each
  wrapping `<issuelink><issuekey>PROJ-45</issuekey>`. Both directions reduce to the same
  ordered relation `(blocker_key → blocked_key)`. Because each link appears on **both**
  issues' XML, collect all directions into a **`set` of `(blocker_key, blocked_key)` tuples**
  to dedupe, then map. Only emit a `Dependency` when **both** endpoints are in the imported
  set; otherwise warn-and-skip (mirrors MSP). Every edge → `dep_type=FS, lag=0`.

**Duration mapping.** `days = max(1, ceil(seconds / 28800))` — a fixed 8h working day for v1.
Reading the project calendar's hours-per-day is a noted follow-up, not v1. Story-point
fallback is explicitly **out of scope for v1** (note in the importer + docs).

**App + entry point.** New Django app `apps/jiraimport/`, structured as a near-copy of the
MSP scaffold (the two import domains diverge in file semantics; coupling them through one
polymorphic model would force the MSP drain to branch — not worth it for ~40 lines of outbox
boilerplate; a shared `AbstractImportRequest` base is a YAGNI-until-a-third-importer defer):
- `JiraImportView` — project-scoped, RBAC identical to MSP:
  `[IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]` + in-body
  `_check_project_role(user, project_pk, Role.ADMIN)`. Writes one `JiraImportRequest` outbox
  row (own model, mirrors `msproject.ImportRequest`: base64 file content, `creates_project`,
  status lifecycle) inside `transaction.atomic()`, defers dispatch via
  `transaction.on_commit()`.
- Celery `import_jira` task — drains the `JiraImportRequest` outbox, parses XML into
  dataclasses, calls `import_jira_project(project_id, data, tracker, wipe_existing)` under
  `TaskRunTracker(task_name="import.jira")`, then `enqueue_recalculate(project_id)`. A drain
  reaper mirrors MSP's orphan handling.

**Two-pass build, keyed by Jira issue key.** Same in-memory pattern MSP uses
(`task_uid_to_pk`): pass 1 `bulk_create` tasks and populate `jira_key_to_pk[item.key] =
str(task.pk)`; pass 2 resolve each `(blocker_key, blocked_key)` through the map to build
`Dependency(predecessor_id, successor_id, FS, lag=0)`. This is why neither `Task` nor
`Dependency` needs a new `external_id` column — the key lives only in the importer's memory
for the duration of the run. **Before** `bulk_create`, call `validate_task_graph(edges,
children_map=…)` (#1665); a cycle rejects the whole import.

## Consequences

- One shared cycle/self-ref primitive (`find_cycle`) now covers human, agent, and both
  importer paths; the guard is the reusable seam and the interactive serializer is left
  untouched (no interactive-path regression risk).
- Jira teams get a real on-ramp to CPM scheduling with zero connector/auth surface. The
  importer is additive scaffolding (new app, new outbox model → one migration in
  `jiraimport`), no change to the scheduler and no change to core `projects` models.
- `InfeasibleGraphError` is a new domain exception importers must catch/surface; the
  DependencyViewSet keeps its existing `CycleDetectedError` mapping unchanged.
- **Non-goal noted:** Jira Cloud has no native XML export. v1 targets Server/DC XML because
  CSV cannot carry issuelinks (the edges are the value). Cloud/CSV support is a tracked
  follow-up, not a blocker — the OSS carve-out and the CPM-network goal are both fully served
  by XML for v1.
- Duration uses a fixed 8h/day; a project whose calendar differs will see estimates that
  round against that assumption until the follow-up reads calendar hours.

## Open questions

None blocking — both issues are prescriptive. Two decisions were made inline rather than
deferred:

1. 🟡 **Cloud export gap** — resolved as a documented v1 limitation (XML/Server-DC only,
   CSV follow-up), not a blocker, because XML is *required* for the dependency-bearing import
   that gives the feature its value.
2. 🟡 **Cyclic-import policy** — resolved as reject-whole-import (atomic) for true cycles vs
   quarantine-and-warn for self-loops, rather than guessing which edge to drop.
