# ADR-1050: Configurable task statuses over a fixed canonical set — per-project workflow states, statuses first, transitions second

## Status

Proposed (2026-09-05). Resolves #3165. Extends ADR-0039 (board column config) and
the lane model introduced in #2967. Unblocks the mapping layer of the Taiga importer
(#3164) and every importer after it.

## Context

`TaskStatus` is a six-value closed enum on `Task.status`: `BACKLOG`, `NOT_STARTED`,
`IN_PROGRESS`, `REVIEW`, `COMPLETE`, and the legacy `ON_HOLD`. It is reasoned about by
**28 non-test backend modules** (the sprint state machine, summary rollup,
`percent_complete` coercion in `save()`, program rollup and program schedule, the
standup and retro services, every importer's mapping layer, the notification and
observability selectors, the MCP read tools) and by **roughly a hundred web call sites**
across schedule, board, sprints, resource, grid, and filters (verified by grep,
2026-09-05).

`BoardColumnConfig` lets a PM rename, reorder, hide, color, and WIP-cap the five
canonical columns, and — since #2967 — nest named **lanes** inside a column. Its
docstring records the load-bearing design fact: the serializer rejects a repeated
status key, and lanes hang off a column precisely so "a team can add Review / QA /
Blocked as distinct board stages without a single consumer of `status` having to
change". Lanes solved the *board vocabulary* half of the problem.

What lanes do not solve: the task itself does not carry the lane. A lane is a
board-rendering detail, not a task attribute, so "every task in UAT" cannot be
filtered, listed over the API, cited in a status update, read by an MCP tool, or
targeted by a transition rule. An importer mapping Taiga's or OpenProject's per-project
statuses onto five values is lossy however cleverly it picks lanes, because the source
status never survives as a fact about the task.

The competitive fact is stark and free-tier: OpenProject Community ships unlimited
per-project statuses and a per-type, per-role transition matrix; Taiga ships
per-project statuses. A team whose workflow is `Triage → Spec → Build → QA → UAT →
Done` hits a hard stop in a TruePPM evaluation at roughly the twenty-minute mark.

## Decision

**Statuses become configurable per project. The six-value enum stays as the canonical
set every subsystem keeps reasoning against. Transitions follow in a second step.**

1. **`ProjectWorkflowState`** — a project-scoped row: `key` (slug, unique per project),
   `label`, `canonical` (one of the five live `TaskStatus` values), `order`, `color`,
   `wip_limit`, `is_default_for_canonical` (exactly one state per canonical value per
   project). UUID PK, `server_version`. A project is created with five states mirroring
   the canonical set, so the default experience is unchanged.

2. **`Task.status` stays the canonical enum.** Nothing that reads it changes. `Task`
   gains `workflow_state` (FK, nullable during migration, non-null after). The model
   invariant, enforced in `save()` alongside the existing `percent_complete` coercion:
   `task.status == task.workflow_state.canonical`. Writes accept either — a client
   that sets `status` lands in that canonical's default state; a client that sets
   `workflow_state` gets `status` derived. That is why the 28 backend modules and the
   web call sites are **untouched** by this decision: they read the canonical value
   they always read.

3. **Board columns become the project's workflow states.** `BoardColumnConfig.columns`
   is migrated into `ProjectWorkflowState` rows — each column becomes a state carrying
   its canonical; each lane becomes a state with its parent column's canonical. Column
   ordering, visibility, color, and WIP limits move onto the state. `BoardColumnConfig`
   is then a derived read for one release and removed. The lane serializer's "reject a
   repeated status key" rule becomes "a canonical value may back many states, and
   exactly one is the default" — the same invariant, stated at the right level.

4. **Semantic contract for every consumer.** Anything that needs to know "is this
   done / active / not started / backlog / in review" reads `Task.status`. Anything
   that needs the team's word for it reads `workflow_state.label`. Sprint commit,
   carryover, close, summary rollup, `percent_complete`, CPM progress, program rollup,
   and the MCP `get_board_state` / `list_tasks` tools keep their behavior by
   construction; MCP tools additionally expose `workflow_state` so an agent sees the
   team's vocabulary.

5. **Importers** map a source status to `(label, canonical)`: the label is preserved as
   a new state, the canonical is a guess the import preview lets the operator correct
   per state before commit. Taiga's per-project statuses import losslessly. This is the
   mapping layer #3164 was blocked on.

6. **Transitions — step two, OSS.** An allowed-transition matrix per project, with an
   optional role floor per transition, ships as a follow-on issue after statuses.
   Within one project it is the PM's own working rule and is OSS by ADR-1048's
   principle. **Org-wide workflow templates**, mandated statuses, and policy-locked
   transitions across programs are Enterprise and register against a
   `dispatch_extension_signal()` on state change.

7. **Sequencing.** Statuses (steps 1–5) at **0.6**, beside the importer breadth they
   unblock. #3164 (Taiga, 0.5) proceeds in two ways at the PM's choice until then: a
   documented collapse to the five canonicals, or the lane mapping (column = canonical,
   lane = Taiga status) that loses nothing on the board and only the filterable fact.
   Transitions (step 6) are filed against 0.7 on acceptance.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Hold the fixed set as a deliberate opinion** | Zero cost; every invariant stays trivially true | The evaluation hard stop stays; both free-tier competitors give the capability away; every importer stays lossy. Publishing the opinion does not change the twenty-minute mark. |
| **B. Free-form `status` string per project** | Simplest data model | Breaks every one of the 28 backend modules and the web call sites that pattern-match the enum; the sprint machine, rollup, and CPM progress lose their contract; importers still need a canonical to know what "done" means. |
| **C. Canonical enum retained, project workflow states layered on it (chosen)** | Every existing consumer untouched; the team's vocabulary becomes a task fact; importers become lossless; transitions have a place to attach; the invariant is one line in `save()` | Two fields that must agree; a migration touching every task row (additive, backfilled from the existing five-state mapping, idempotent); `BoardColumnConfig` lifecycle to manage. |
| **D. Lanes only — status quo, documented** | Already shipped; board vocabulary problem solved | The task never carries the lane; no filter, no API fact, no MCP read, no transition target; importers stay lossy. It is the right *board* answer and the wrong *status* answer. |

## Consequences

**Easier.** A team expresses its own workflow in the first session. Importers preserve
source vocabulary. Status updates (#3425) and MCP tools cite the team's words.
Transition rules have an object to hang on. The "custom work-item types and statuses"
row on the comparison page stops being a loss.

**Harder.** Two agreeing fields is a class of bug the `save()` invariant and a
database `CHECK`-equivalent (a constraint on the join, or a trigger-free validation in
the serializer and model) must hold on every write path, including bulk endpoints,
sync upload, and every importer. The migration is the largest single-row backfill
since the WBS work and needs the `RunPython`-before-constraint shape rule 7 requires.

**Risks.** Consumers that *display* status by enum label (the board's default column
names, the grid, the drawer) will show the canonical label where the team expects its
own; the web sweep is display-only but wide. Mitigation: ship `workflow_state` on every
task serializer from the first release so the web can migrate display sites
incrementally behind the same data.

## Implementation Notes

- **P3M layer:** Programs and Projects.
- **Affected packages:** api (model, migration, serializers, board config, importers,
  MCP tools), web (board, grid, drawer, filters, schedule labels), docs.
- **Migration required:** yes — `ProjectWorkflowState` table, five default rows per
  project, `Task.workflow_state` backfilled from `status`, `BoardColumnConfig` columns
  and lanes folded in. `RunPython` precedes any constraint (rule 7).
- **API changes:** yes — `workflow_state` on task read/write, a project-scoped
  workflow-states CRUD endpoint, importer preview mapping. `docs/api/openapi.json`
  regenerated; `docs/api/stability.md` notes `BoardColumnConfig`'s one-release derived
  window.
- **OSS or Enterprise:** OSS for per-project states and transitions; Enterprise for
  org-wide templates and mandated policy, via the state-change extension signal.

### Durable Execution

1. **Broker-down behaviour:** N/A — state CRUD and task writes are synchronous;
   the existing task write path's `broadcast_board_event()` under
   `transaction.on_commit()` carries the new field.
2. **Drain task:** N/A — no new async work.
3. **Orphan window:** N/A.
4. **Service layer:** a single `resolve_workflow_state(project, status=None,
   workflow_state=None)` in `projects/services.py` used by every write path (serializer,
   bulk, sync upload, importers) so the invariant is computed in one place.
5. **API response on best-effort dispatch:** N/A — synchronous.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** the backfill migration is idempotent (`WHERE workflow_state_id IS
   NULL`).
8. **Dead-letter / failure handling:** N/A.

### On Acceptance

- [ ] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1050`
- [ ] Implementation issue filed for steps 1–5 at 0.6 with the 28-module blast radius
      listed; transitions issue filed at 0.7; #3164's body updated with the interim
      lane mapping; record the count rewritten.
- [ ] `overview/how-it-compares.md` "Custom work-item types and statuses" row and
      `overview/what-it-does-not-do.md` "Workflow" section updated to the decision.
